import * as errore from "errore"
import type { Database } from "../Database.js"
import type { ScanWindow } from "../query/Query.js"
import type { AnyRelations, AnySchema } from "../schema/Schema.js"
import type { CollectionCodecs } from "../schema/collectionCodecs.js"
import {
	SyncEngine,
	type ClientId,
	type PushResponse,
	type RemoteApi,
} from "../sync/SyncEngine.js"
import type { Mutation, MutationId } from "../transaction/Transaction.js"
import type { LoggerApi } from "../utils/Logger.js"
import type { RngApi } from "../utils/randomId.js"
import { isEqual } from "../utils/objectUtils.js"
import { ThrottleQueue } from "../utils/ThrottleQueue.js"
import type { TimerApi } from "../utils/Timer.js"
import { tag, unreachable, type Unsubscribe } from "../utils/typeUtils.js"
import type { TabChannelApi, TabMessageListener } from "./TabEnvironment.js"
import {
	TabCodec,
	type TabMessage,
	type TabRequest,
	type TabResult,
	type TabView,
} from "./TabProtocol.js"

const INHERITED_QUERY_GRACE_MS = 60_000
class TabViewError extends errore.createTaggedError({
	name: "TabViewError",
	message: "Unable to encode tab view",
}) {}
class TabConnectionError extends errore.createTaggedError({
	name: "TabConnectionError",
	message: "Leader connection did not complete",
}) {}
class TabServerError extends errore.createTaggedError({
	name: "TabServerError",
	message: "$detail",
}) {}
/** The latest remote push that carried a leader mutation a tab is waiting on. */
type PushAttempt = { response?: Promise<PushResponse> }
type SessionState<Schema extends AnySchema> = {
	scanWindow: ScanWindow<Schema>
	subscriptions: Map<string, Unsubscribe>
	inherited: boolean
	lastView?: TabView<Schema>
	watching: boolean
	/** Records the join restored outside the scan window, which views keep sending. */
	restored: Set<string>
}
type TabHubArgs<
	Schema extends AnySchema,
	Relations extends AnyRelations<Schema>,
> = {
	channel: TabChannelApi
	db: Database<Schema, Relations>
	remote: RemoteApi<Schema>
	syncInterval: TimerApi
	codecs: CollectionCodecs<Schema>
	logger: LoggerApi
	rng: RngApi
	watchTab: (tabId: string, closed: () => Promise<void>) => Promise<void>
}
const recordKey = ({
	collection,
	value,
}: {
	collection: string
	value: { id: unknown }
}) => JSON.stringify([collection, value.id])
const errorMessage = (error: unknown) =>
	error instanceof Error ? error.message : String(error)
const unavailable = (error: unknown) => ({
	error: "unavailable" as const,
	message: errorMessage(error),
})

/** Owns persisted data and server synchronization; tabs use direct commands and views. */
export class TabHub<
	Schema extends AnySchema,
	Relations extends AnyRelations<Schema> = AnyRelations<Schema>,
> {
	readonly leaderId: string
	private readonly channel: TabChannelApi
	private readonly db: Database<Schema, Relations>
	private readonly syncEngine: SyncEngine<Schema>
	private readonly codecs: CollectionCodecs<Schema>
	private readonly logger: LoggerApi
	private readonly watchTab: TabHubArgs<Schema, Relations>["watchTab"]
	private readonly sessions = new Map<ClientId, SessionState<Schema>>()
	private readonly pushAttempts = new Map<MutationId, PushAttempt>()
	private readonly connectedSessions = new Set<ClientId>()
	private readonly views: ThrottleQueue<void>
	private connection: Promise<void> = Promise.resolve()
	/** Whether the leader holds a server connection; `connection` orders changes. */
	private connected = false
	/** Settles when the remote answers the connect in progress. */
	private registration?: PromiseWithResolvers<void>
	private revision = 0
	private stopped = false
	private inheritedQueryTimer?: ReturnType<typeof setTimeout>
	private unsubscribeFromRecords?: Unsubscribe

	constructor(args: TabHubArgs<Schema, Relations>) {
		this.channel = args.channel
		this.db = args.db
		const { remote } = args
		this.syncEngine = new SyncEngine({
			// Observe pushes so a tab's commit awaits the server response that carried it.
			remote: {
				connect: async (api) => {
					// Answer the connect that made this call, not one started later.
					const registration = this.registration
					const result = await remote.connect(api)
					if (typeof result === "function") registration?.resolve()
					else registration?.reject(new TabConnectionError({ cause: result }))
					return result
				},
				pull: (request) => remote.pull(request),
				push: (request) => {
					const response = remote.push(request)
					if (request.clientId === this.db.replica.clientId)
						for (const { id } of request.mutations) {
							const attempt = this.pushAttempts.get(id)
							if (attempt) attempt.response = response
						}
					return response
				},
			},
			db: args.db,
			autoConnect: false,
			logger: args.logger.scope("sync-engine"),
			rng: args.rng,
			syncInterval: args.syncInterval,
		})
		this.codecs = args.codecs
		this.logger = args.logger
		this.watchTab = args.watchTab
		this.leaderId = args.rng.randomId()
		this.views = new ThrottleQueue(() => this.publishViews(), {
			waitForNextTick: () => Promise.resolve(),
		})
	}

	start() {
		for (const { clientId, scanWindow } of this.db.sessionScanWindows()) {
			const state = this.getSession(clientId)
			state.inherited = true
			this.subscribe(clientId, state, scanWindow)
		}
		this.inheritedQueryTimer = setTimeout(() => {
			for (const [sessionId, state] of this.sessions)
				if (state.inherited) this.forget(sessionId)
		}, INHERITED_QUERY_GRACE_MS)
		// In Node, such as a worker or a test, this grace period must not keep the
		// process alive. Browsers return a number without `unref`.
		;(this.inheritedQueryTimer as { unref?: () => void }).unref?.()
		this.channel.addEventListener("message", this.onMessage)
		this.unsubscribeFromRecords = this.db.subscribeToRecords(() =>
			this.queueViews(),
		)
		this.post({ type: "leader", leaderId: this.leaderId })
	}

	async stop() {
		this.stopped = true
		clearTimeout(this.inheritedQueryTimer)
		this.channel.removeEventListener("message", this.onMessage)
		this.channel.close()
		this.unsubscribeFromRecords?.()
		this.registration?.resolve()
		this.registration = undefined
		this.connected = false
		await this.syncEngine.disconnect()
		const flushed = await this.db.flushClientStorage()
		if (flushed instanceof Error)
			this.logger.error({
				message: "error flushing leader storage",
				error: flushed,
			})
	}

	private readonly onMessage: TabMessageListener = ({ data }) => {
		const message = data as TabMessage<Schema>
		switch (message.type) {
			case "hello":
				this.post({ type: "leader", leaderId: this.leaderId })
				return
			case "request": {
				// A late announcement from an earlier leader can redirect a tab to it.
				// Correct a tab that joins anyone else, since only one leader runs.
				if (message.leaderId !== this.leaderId) {
					if (message.request.method === "join")
						this.post({ type: "leader", leaderId: this.leaderId })
					return
				}
				const respond = (
					result: TabResult<Schema>,
					stage: "saved" | "complete" = "complete",
				) =>
					this.post({
						type: "response",
						leaderId: this.leaderId,
						sessionId: message.sessionId,
						requestId: message.requestId,
						stage,
						result,
					})
				void this.handle(
					message.sessionId,
					message.request as TabRequest<Schema>,
					(result) => respond(result, "saved"),
				).then(
					(result) => respond(result),
					(error: unknown) => {
						this.logger.error({ message: "error serving tab request", error })
						respond(unavailable(error))
					},
				)
				return
			}
			case "leader":
			case "view":
			case "response":
				return
			default:
				return unreachable(message)
		}
	}

	private async handle(
		sessionId: ClientId,
		request: TabRequest<Schema>,
		saved: (result: TabResult<Schema>) => void,
	): Promise<TabResult<Schema>> {
		switch (request.method) {
			case "join": {
				const state = this.getSession(sessionId)
				state.inherited = false
				if (!state.watching) {
					state.watching = true
					void this.watchTab(request.tabId, async () => {
						if (this.stopped || this.sessions.get(sessionId) !== state) return
						this.forget(sessionId)
						await this.updateConnection()
					}).catch((error: unknown) =>
						this.logger.error({
							message: "error watching tab lifetime",
							error,
						}),
					)
				}
				this.subscribe(sessionId, state, request.scanWindow)
				if (request.connected) this.connectedSessions.add(sessionId)
				else this.connectedSessions.delete(sessionId)
				// Connection work is separate from local restore and saving. Replayed writes
				// capture this barrier before waiting for their server result.
				void this.updateConnection({ sync: request.connected }).catch(
					(error: unknown) => {
						this.logger.error({
							message: "error connecting tab replica",
							error,
						})
					},
				)
				return this.snapshot(sessionId, true)
			}
			case "subscribe":
				this.subscribe(
					sessionId,
					this.getSession(sessionId),
					request.scanWindow,
				)
				return this.snapshot(sessionId)
			case "commit": {
				const mutation = TabCodec.decodeMutation(this.codecs, request.mutation)
				return this.commit(sessionId, mutation, request.waitForServer, saved)
			}
			case "finishWrite": {
				const receipt = this.db.tabWrite(sessionId, request.mutationId)
				if (receipt) this.pushAttempts.delete(receipt.mutationId)
				this.db.forgetTabWrite(sessionId, request.mutationId)
				return { ok: true }
			}
			case "connect":
				this.connectedSessions.add(sessionId)
				await this.updateConnection({ sync: true })
				return { ok: true }
			case "disconnect":
				this.connectedSessions.delete(sessionId)
				await this.updateConnection()
				return { ok: true }
			case "pullFromRemote":
				await this.syncEngine.queuePull()
				return this.snapshot(sessionId)
			case "flush": {
				const result = await this.db.flushClientStorage()
				return result instanceof Error ? unavailable(result) : { ok: true }
			}
			case "clear": {
				this.pushAttempts.clear()
				const cleared = await this.syncEngine
					.clear()
					.catch((cause: unknown) => new TabConnectionError({ cause }))
				// A failed clear leaves the engine disconnected; reconnect if tabs want it.
				if (cleared instanceof Error) {
					this.connected = false
					void this.updateConnection().catch(() => {})
					return unavailable(cleared)
				}
				for (const [clientId, state] of this.sessions)
					this.db.setSessionScanWindow(clientId, state.scanWindow)
				this.queueViews()
				return this.snapshot(sessionId)
			}
			case "leave":
				this.forget(sessionId)
				await this.updateConnection()
				return { ok: true }
			default:
				return unreachable(request)
		}
	}

	private get wantsConnection() {
		return !this.stopped && this.connectedSessions.size > 0
	}

	private updateConnection({ sync = false } = {}) {
		// A disconnect must not wait for a connect the remote has not answered. The
		// queued disconnect below then cancels that connect, as SyncEngine does.
		if (!this.wantsConnection) this.registration?.resolve()
		this.connection = this.connection
			.catch(() => {})
			.then(async () => {
				const wanted = this.wantsConnection
				if (wanted && !this.connected) {
					// SyncEngine.connect also pulls and pushes. Connection control waits
					// only for the remote to accept, so a stalled sync cannot block it.
					const registration = Promise.withResolvers<void>()
					this.registration = registration
					void this.syncEngine.connect().catch((cause: unknown) => {
						registration.reject(new TabConnectionError({ cause }))
						this.logger.error({
							message: "error syncing after connect",
							error: cause,
						})
					})
					await registration.promise
					this.connected = true
				} else if (wanted && sync) {
					// Like connect, pull and then push what is still pending.
					void this.syncEngine
						.queuePull()
						.then(() => this.syncEngine.queuePush())
						.catch((error: unknown) =>
							this.logger.error({
								message: "error syncing after connect",
								error,
							}),
						)
				}
				// Disconnecting also cancels a connect the remote has not answered.
				if (!wanted && (this.connected || this.registration)) {
					this.connected = false
					this.registration = undefined
					await this.syncEngine.disconnect()
				}
			})
		return this.connection
	}

	private async commit(
		sessionId: ClientId,
		mutation: Mutation<Schema>,
		waitForServer: boolean,
		saved: (result: TabResult<Schema>) => void,
	): Promise<TabResult<Schema>> {
		const lastMutationId = this.db.sessionLastMutationId(sessionId)
		let committed: Promise<void> | undefined
		if (lastMutationId === undefined || mutation.id > lastMutationId) {
			if (lastMutationId !== undefined && mutation.id !== lastMutationId + 1)
				return unavailable(
					`Expected tab mutation ${lastMutationId + 1}, received ${mutation.id}`,
				)
			const tx = this.db.transact()
			for (const op of mutation.ops) {
				switch (op.type) {
					case "set":
						tx.set(op.collection, op.value)
						break
					case "update":
						tx.update(op.collection, op.id, op.payload)
						break
					case "remove":
						tx.remove(op.collection, op.id)
						break
					default:
						unreachable(op)
				}
			}
			committed = this.syncEngine.commit(tx, {
				clientId: sessionId,
				mutationId: mutation.id,
			})
			committed.catch((error: unknown) =>
				this.logger.error({
					message: "error pushing forwarded mutation",
					error,
				}),
			)
		}
		// A repeated request finds the receipt that the first one committed atomically.
		const receipt = this.db.tabWrite(sessionId, mutation.id)
		if (!receipt || receipt.clientId !== this.db.replica.clientId)
			return unavailable("Forwarded write was cleared")
		// Track pushes before the sync queue can run one.
		const attempt = waitForServer
			? this.pushAttempt(receipt.mutationId)
			: undefined
		const flushed = await this.db.flushClientStorage()
		if (flushed instanceof Error) return unavailable(flushed)
		saved({ ok: true })
		this.queueViews()
		if (!attempt) return { ok: true }
		const result = await committed?.catch(
			(cause: unknown) =>
				new TabServerError({ detail: errorMessage(cause), cause }),
		)
		if (result instanceof Error) return unavailable(result)
		const pushed = await this.awaitServer(receipt.mutationId, attempt)
		if (pushed instanceof Error) return unavailable(pushed)
		if (receipt.clientId !== this.db.replica.clientId)
			return unavailable("Forwarded write was cleared")
		return { ok: true }
	}

	private pushAttempt(mutationId: MutationId) {
		const existing = this.pushAttempts.get(mutationId)
		if (existing) return existing
		const attempt: PushAttempt = {}
		this.pushAttempts.set(mutationId, attempt)
		return attempt
	}

	/**
	 * Awaits the push that carried a leader mutation. The original commit skips
	 * its push while disconnected, and a replacement leader inherits the
	 * mutation without its commit, so either pushes once the connection settles.
	 */
	private async awaitServer(mutationId: MutationId, attempt: PushAttempt) {
		if (!attempt.response) {
			const connection = await this.connection.catch(
				(cause: unknown) => new TabConnectionError({ cause }),
			)
			// Like standalone commits after a failed auto-connect, keep the write offline.
			// The connection path already reports the failure to the logger.
			if (connection instanceof Error || this.stopped) return
			if (!attempt.response && this.db.outbox.get([mutationId])) {
				const pushed = await this.syncEngine
					.queuePush()
					.catch(
						(cause: unknown) =>
							new TabServerError({ detail: errorMessage(cause), cause }),
					)
				if (pushed instanceof Error) return pushed
			}
		}
		const response = await attempt.response?.catch(
			(cause: unknown) =>
				new TabServerError({ detail: errorMessage(cause), cause }),
		)
		if (response instanceof Error) return response
		if (response && "error" in response)
			return new TabServerError({
				detail: "Remote push failed",
				cause: response,
			})
	}

	private getSession(sessionId: ClientId) {
		const existing = this.sessions.get(sessionId)
		if (existing) return existing
		const state: SessionState<Schema> = {
			scanWindow: [],
			subscriptions: new Map(),
			inherited: false,
			watching: false,
			restored: new Set(),
		}
		this.sessions.set(sessionId, state)
		return state
	}

	private subscribe(
		sessionId: ClientId,
		state: SessionState<Schema>,
		scanWindow: ScanWindow<Schema>,
	) {
		state.scanWindow = scanWindow
		const queries = new Map(
			scanWindow.map((query) => [JSON.stringify(query), query]),
		)
		for (const [key, unsubscribe] of state.subscriptions) {
			if (queries.has(key)) continue
			unsubscribe()
			state.subscriptions.delete(key)
		}
		for (const [key, query] of queries)
			if (!state.subscriptions.has(key))
				state.subscriptions.set(key, this.syncEngine.subscribe(query))
		this.db.setSessionScanWindow(sessionId, scanWindow)
	}

	private forget(sessionId: ClientId) {
		for (const unsubscribe of this.sessions
			.get(sessionId)
			?.subscriptions.values() ?? [])
			unsubscribe()
		this.sessions.delete(sessionId)
		this.connectedSessions.delete(sessionId)
		for (const receipt of this.db.forgetTabWrites(sessionId))
			this.pushAttempts.delete(receipt.mutationId)
		this.db.setSessionScanWindow(sessionId, undefined)
	}

	private captureView(sessionId: ClientId, restore = false) {
		const state = this.getSession(sessionId)
		const records = restore
			? this.db.scanRecords()
			: this.db.scanWindow(state.scanWindow)
		if (records instanceof Error) return records
		// A tab restores every record when it joins. Keep sending the ones outside its
		// scan window, so a view does not remove them, until they enter the window or
		// are deleted.
		if (restore) state.restored = new Set(records.map(recordKey))
		else if (state.restored.size > 0) {
			for (const record of records) state.restored.delete(recordKey(record))
			const kept = this.db
				.scanRecords()
				.filter((record) => state.restored.has(recordKey(record)))
			state.restored = new Set(kept.map(recordKey))
			records.push(...kept)
		}
		const lastMutationId =
			this.db.sessionLastMutationId(sessionId) ?? tag<MutationId>(0)
		const encoded = errore.try({
			try: () =>
				TabCodec.encodeView(this.codecs, {
					revision: ++this.revision,
					records,
					lastMutationId,
				}),
			catch: (cause) => new TabViewError({ cause }),
		})
		if (encoded instanceof Error) return encoded
		const previous = state.lastView
		if (
			!restore &&
			previous?.lastMutationId === lastMutationId &&
			isEqual(previous.records, encoded.records)
		)
			return
		return encoded
	}

	private async snapshot(
		sessionId: ClientId,
		restore = false,
	): Promise<TabResult<Schema>> {
		const view = this.captureView(sessionId, restore)
		if (view instanceof Error) return unavailable(view)
		const flushed = await this.db.flushClientStorage()
		if (flushed instanceof Error) return unavailable(flushed)
		if (view) this.rememberView(sessionId, view)
		return { ok: true, view }
	}

	private queueViews() {
		if (this.stopped) return
		void this.views.enqueue()
	}

	private async publishViews() {
		if (this.stopped) return
		const views = [...this.sessions]
			.filter(([, state]) => !state.inherited)
			.map(([sessionId]) => ({ sessionId, view: this.captureView(sessionId) }))
		const flushed = await this.db.flushClientStorage()
		if (flushed instanceof Error) {
			this.logger.error({ message: "error saving tab view", error: flushed })
			return
		}
		const groups: { sessionIds: ClientId[]; view: TabView<Schema> }[] = []
		for (const { sessionId, view } of views) {
			if (view instanceof Error) {
				this.logger.error({ message: "error publishing tab view", error: view })
				continue
			}
			if (!view) continue
			const group = groups.find(
				(entry) =>
					entry.view.lastMutationId === view.lastMutationId &&
					isEqual(entry.view.records, view.records),
			)
			if (group) {
				group.sessionIds.push(sessionId)
				group.view = view
			} else groups.push({ sessionIds: [sessionId], view })
		}
		// BroadcastChannel delivers every message to every tab. Share identical
		// views in one broadcast instead of cloning the same rows once per tab.
		for (const { sessionIds, view } of groups) {
			for (const sessionId of sessionIds) this.rememberView(sessionId, view)
			this.post({ type: "view", leaderId: this.leaderId, sessionIds, view })
		}
	}

	private rememberView(sessionId: ClientId, view: TabView<Schema>) {
		const state = this.sessions.get(sessionId)
		if (state && (!state.lastView || state.lastView.revision < view.revision))
			state.lastView = view
	}

	private post(message: TabMessage<Schema>) {
		if (!this.stopped) this.channel.postMessage(message)
	}
}
