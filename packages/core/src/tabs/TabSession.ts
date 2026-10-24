import * as errore from "errore"
import type { Database } from "../Database.js"
import type { EncodedQuery, ScanWindow } from "../query/Query.js"
import type { AnyRelations, AnySchema } from "../schema/Schema.js"
import type { CollectionCodecs } from "../schema/collectionCodecs.js"
import type { ClientId } from "../sync/SyncEngine.js"
import type {
	Mutation,
	MutationId,
	Transaction,
} from "../transaction/Transaction.js"
import type { LoggerApi } from "../utils/Logger.js"
import type { RngApi } from "../utils/randomId.js"
import { tag, unreachable } from "../utils/typeUtils.js"
import type {
	TabChannelApi,
	TabEnvironmentApi,
	TabMessageListener,
} from "./TabEnvironment.js"
import { tabLifetimeLock } from "./TabEnvironment.js"
import type { TabHub } from "./TabHub.js"
import {
	TabCodec,
	type TabMessage,
	type TabRequest,
	type TabResult,
	type TabView,
} from "./TabProtocol.js"

class TabRequestError extends errore.createTaggedError({
	name: "TabRequestError",
	message: "$detail",
}) {}

const mutationIdOf = <Schema extends AnySchema>({
	message: { request },
}: PendingRequest<Schema>) =>
	request.method === "commit" ? request.mutation.id : 0

type PendingRequest<Schema extends AnySchema> = {
	message: Extract<TabMessage<Schema>, { type: "request" }>
	result: ReturnType<typeof Promise.withResolvers<TabResult<Schema>>>
	saved: ReturnType<typeof Promise.withResolvers<TabResult<Schema>>>
}

export type TabSessionArgs<
	Schema extends AnySchema,
	Relations extends AnyRelations<Schema>,
> = {
	name: string
	environment: TabEnvironmentApi
	codecs: CollectionCodecs<Schema>
	db: Database<Schema, Relations>
	autoConnect: boolean
	logger: LoggerApi
	rng: RngApi
	lead: (channel: TabChannelApi) => Promise<TabHub<Schema, Relations>>
}

/** Local tab transport and completion tracking; the database owns pending edits. */
export class TabSession<
	Schema extends AnySchema,
	Relations extends AnyRelations<Schema> = AnyRelations<Schema>,
> {
	readonly ready: Promise<void>
	isReady = false
	private readonly restored = Promise.withResolvers<void>()
	private readonly pending = new Map<string, PendingRequest<Schema>>()
	private readonly channel: TabChannelApi
	private readonly codecs: CollectionCodecs<Schema>
	private readonly db: Database<Schema, Relations>
	private readonly logger: LoggerApi
	private readonly rng: RngApi
	private readonly released = Promise.withResolvers<void>()
	private readonly led: Promise<void>
	private readonly tabId: string
	private scanWindow: ScanWindow<Schema> = []
	private wantsRemote: boolean
	private leaderId?: string
	private revision = -1
	/** The last local mutation the leader has saved; later outbox entries may need resending. */
	private savedThrough = tag<MutationId>(0)
	private joined = false
	private joining = false
	private leading = false
	private closed = false
	private subscriptionQueued = false
	private leadError?: unknown

	constructor(args: TabSessionArgs<Schema, Relations>) {
		this.db = args.db
		this.codecs = args.codecs
		this.logger = args.logger
		this.rng = args.rng
		this.wantsRemote = args.autoConnect
		this.tabId = this.db.replica.clientId
		this.ready = this.restored.promise
		const name = `tandem:${args.name}`
		void args.environment.locks
			.request(
				tabLifetimeLock(args.name, this.tabId),
				() => this.released.promise,
			)
			.catch((error: unknown) => {
				this.logger.error({ message: "error holding tab lifetime lock", error })
			})
		this.channel = args.environment.openChannel(name)
		this.channel.addEventListener("message", this.onMessage)
		this.channel.postMessage({ type: "hello" } satisfies TabMessage<Schema>)
		this.led = args.environment.locks
			.request(name, async () => {
				if (this.closed) return
				this.leading = true
				const hub = await args.lead(args.environment.openChannel(name))
				await this.released.promise
				await hub.stop()
			})
			.catch((error: unknown) => {
				this.logger.error({ message: "error leading tabs", error })
				this.leading = false
				this.leadError = error
				this.restored.reject(error)
				this.failPending(error instanceof Error ? error.message : String(error))
			})
	}

	commit(transaction: Transaction<Schema>) {
		// The leader accepts each tab's mutations in order, so older unsaved ones go first.
		this.retryWrites()
		this.db.commitMutation(transaction)
		const call = this.submit(
			this.db.replica.lastIssuedMutationId,
			transaction.ops,
			this.wantsRemote,
		)
		return call.result.promise.then((result) => this.resultError(result))
	}

	subscribe(query: EncodedQuery<Schema>) {
		this.scanWindow.push(query)
		this.queueSubscriptions()
		return () => {
			this.scanWindow = this.scanWindow.filter((entry) => entry !== query)
			this.queueSubscriptions()
		}
	}

	async connect() {
		this.wantsRemote = true
		const result = await this.control("connect")
		if (!result) this.retryWrites()
		return result
	}

	disconnect() {
		this.wantsRemote = false
		return this.control("disconnect")
	}

	async flush() {
		this.retryWrites()
		const writes = [...this.pending.values()].filter(
			({ message }) => message.request.method === "commit",
		)
		for (const write of writes) {
			const result = await write.saved.promise
			const error = this.resultError(result)
			if (error) return error
		}
		return this.control("flush")
	}

	async clear() {
		const previous = this.db.replica.clientId
		// Writes sent before the clear land in the replica it discards. Later writes
		// reach the cleared replica, so they complete as usual.
		const cleared = [...this.pending].filter(
			([, call]) => call.message.request.method === "commit",
		)
		const result = await this.control("clear")
		if (result instanceof Error) return result
		for (const [requestId, call] of cleared) {
			if (!this.pending.delete(requestId)) continue
			const error = {
				error: "unavailable",
				message: "Forwarded write was cleared",
			} as const
			call.saved.resolve(error)
			call.result.resolve(error)
		}
		await this.db.clear(tag<ClientId>(this.rng.randomId()))
		this.savedThrough = tag<MutationId>(0)
		void this.request({ method: "leave" }, previous)
		const leaderId = this.leaderId
		this.joined = false
		const joined = await this.join()
		// A new leader rejoins this session itself; the clear already happened.
		if (leaderId !== this.leaderId) return
		return this.resultError(joined)
	}

	async control(
		method: "connect" | "disconnect" | "pullFromRemote" | "flush" | "clear",
	) {
		const result = await this.request({ method }).result.promise
		if ("view" in result && result.view) this.applyView(result.view)
		return this.resultError(result)
	}

	async close() {
		if (this.closed) return
		if (this.leaderId !== undefined)
			this.channel.postMessage({
				type: "request",
				leaderId: this.leaderId,
				sessionId: this.db.replica.clientId,
				requestId: this.rng.randomId(),
				request: { method: "leave" },
			} satisfies TabMessage<Schema>)
		this.closed = true
		this.channel.removeEventListener("message", this.onMessage)
		this.channel.close()
		this.failPending("Tab session closed")
		this.released.resolve()
		if (this.leading) await this.led
	}

	private resultError(result: TabResult<Schema>) {
		if ("error" in result)
			return new TabRequestError({ detail: result.message, cause: result })
	}

	/** Sends a local mutation to the leader without applying it again. */
	private submit(
		mutationId: MutationId,
		ops: Mutation<Schema>["ops"],
		waitForServer: boolean,
	) {
		const sessionId = this.db.replica.clientId
		const [mutation] = TabCodec.encodeMutations(this.codecs, [
			{ id: mutationId, ops },
		])
		const call = this.request({
			method: "commit",
			mutation: mutation!,
			waitForServer,
		})
		void call.saved.promise.then((saved) => {
			if ("error" in saved || sessionId !== this.db.replica.clientId) return
			if (mutationId > this.savedThrough) this.savedThrough = mutationId
		})
		void call.result.promise.then(async () => {
			// Retire the receipt only after a confirmed save. A failed save keeps it,
			// and unanswered requests keep it across takeover, so a resend finds it.
			const saved = await call.saved.promise
			if (!("error" in saved))
				void this.request({ method: "finishWrite", mutationId }, sessionId)
		})
		return call
	}

	/** Resends saved-pending outbox mutations that no request is carrying. */
	private retryWrites() {
		const active = new Set(
			[...this.pending.values()].flatMap(({ message: { request } }) =>
				request.method === "commit" ? [request.mutation.id] : [],
			),
		)
		for (const { key, value } of this.db.outbox.scan({
			gt: [this.savedThrough],
		}))
			if (!active.has(key[0])) this.submit(key[0], value, false)
	}

	private request(
		request: TabRequest<Schema>,
		sessionId = this.db.replica.clientId,
	): PendingRequest<Schema> {
		const requestId = this.rng.randomId()
		const call: PendingRequest<Schema> = {
			message: {
				type: "request",
				leaderId: this.leaderId ?? "",
				sessionId,
				requestId,
				request,
			},
			result: Promise.withResolvers<TabResult<Schema>>(),
			saved: Promise.withResolvers<TabResult<Schema>>(),
		}
		if (this.closed || this.leadError) {
			const result = {
				error: "unavailable",
				message: this.closed ? "Tab session closed" : String(this.leadError),
			} as const
			call.result.resolve(result)
			call.saved.resolve(result)
			return call
		}
		this.pending.set(requestId, call)
		if (this.leaderId !== undefined && !this.joined && !this.joining)
			void this.join()
		else this.send(call.message)
		return call
	}

	private send(message: PendingRequest<Schema>["message"]) {
		if (
			this.leaderId === undefined ||
			(!this.joined && message.request.method !== "join")
		)
			return
		// These commands describe current intent, not a history to replay after takeover.
		if (message.request.method === "subscribe")
			message.request.scanWindow = this.scanWindow
		if (
			message.request.method === "connect" ||
			message.request.method === "disconnect"
		)
			message.request = { method: this.wantsRemote ? "connect" : "disconnect" }
		message.leaderId = this.leaderId
		this.channel.postMessage(message)
	}

	private queueSubscriptions() {
		if (this.subscriptionQueued) return
		this.subscriptionQueued = true
		queueMicrotask(() => {
			this.subscriptionQueued = false
			if (this.closed || !this.joined) return
			void this.controlSubscriptions()
		})
	}

	private async controlSubscriptions() {
		const result = await this.request({
			method: "subscribe",
			scanWindow: this.scanWindow,
		}).result.promise
		if ("view" in result && result.view) this.applyView(result.view)
		const error = this.resultError(result)
		if (error)
			this.logger.error({ message: "error updating tab subscriptions", error })
	}

	private applyView(encoded: TabView<Schema>) {
		if (encoded.revision <= this.revision) return
		const view = TabCodec.decodeView(this.codecs, encoded)
		this.db.applyTabView(view)
		this.revision = view.revision
		if (view.lastMutationId > this.savedThrough)
			this.savedThrough = view.lastMutationId
	}

	/** Joins the current leader. A failed join is retried by the next request. */
	private join() {
		const leaderId = this.leaderId
		this.joining = true
		return this.request({
			method: "join",
			tabId: this.tabId,
			scanWindow: this.scanWindow,
			connected: this.wantsRemote,
		}).result.promise.then((result) => {
			if (leaderId !== this.leaderId || this.closed) return result
			if ("error" in result) {
				this.joining = false
				// Writes waiting for this join fail and stay in the outbox for a retry.
				this.restored.reject(this.resultError(result))
				this.failPending(result.message)
				return result
			}
			this.applyView(result.view!)
			// Queue unsaved writes before joining, then resend every write in
			// mutation order: a leader without this tab's marker accepts the first
			// one it receives.
			this.retryWrites()
			this.joining = false
			this.joined = true
			this.isReady = true
			this.restored.resolve()
			this.queueSubscriptions()
			const calls = [...this.pending.values()]
			const writes = calls
				.filter(({ message }) => message.request.method === "commit")
				.sort((a, b) => mutationIdOf(a) - mutationIdOf(b))
			// Writes take the slots writes held, in mutation order; other requests keep theirs.
			for (const call of calls)
				this.send(
					call.message.request.method === "commit"
						? writes.shift()!.message
						: call.message,
				)
			return result
		})
	}

	private failPending(message: string) {
		for (const call of this.pending.values()) {
			const result = { error: "unavailable", message } as const
			call.result.resolve(result)
			call.saved.resolve(result)
		}
		this.pending.clear()
	}

	private readonly onMessage: TabMessageListener = ({ data }) => {
		const message = data as TabMessage<Schema>
		switch (message.type) {
			case "leader": {
				if (message.leaderId === this.leaderId) return
				this.leaderId = message.leaderId
				this.revision = -1
				this.joined = false
				this.joining = false
				// A clear the previous leader may have applied must not run twice.
				for (const [id, call] of this.pending) {
					const { method } = call.message.request
					if (method !== "join" && method !== "clear") continue
					call.result.resolve({
						error: "unavailable",
						message: "Leader changed",
					})
					this.pending.delete(id)
				}
				void this.join()
				return
			}
			case "view":
				// The leader can publish a newer view before it answers the join, and
				// it does not resend a view it has already published.
				if (
					message.leaderId === this.leaderId &&
					message.sessionIds.includes(this.db.replica.clientId)
				)
					this.applyView(message.view)
				return
			case "response": {
				if (message.leaderId !== this.leaderId) return
				const call = this.pending.get(message.requestId)
				if (call?.message.sessionId !== message.sessionId) return
				call.saved.resolve(message.result)
				if (message.stage === "saved") return
				this.pending.delete(message.requestId)
				call.result.resolve(message.result)
				return
			}
			case "hello":
			case "request":
				return
			default:
				return unreachable(message)
		}
	}
}
