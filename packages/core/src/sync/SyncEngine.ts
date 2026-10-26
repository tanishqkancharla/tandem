import * as errore from "errore"
import type { Database } from "../Database.js"
import type { EncodedQuery, ScanWindow } from "../query/Query.js"
import type {
	AnySchema,
	CollectionName,
	RuntimeSchemaDefinition,
} from "../schema/Schema.js"
import type {
	AppendableField,
	Mutation,
	MutationId,
	Transaction,
} from "../transaction/Transaction.js"
import { codec as createCodec, type Codec } from "../utils/Codec.js"
import type { LoggerApi } from "../utils/Logger.js"
import { isObject } from "../utils/objectUtils.js"
import { randomId, type RngApi } from "../utils/randomId.js"
import { TaskQueue } from "../utils/TaskQueue.js"
import { Timer, type TimerApi } from "../utils/Timer.js"
import { tag } from "../utils/typeUtils.js"
import type {
	AsyncUnsubscribe,
	Tagged,
	Unsubscribe,
} from "../utils/typeUtils.js"

export type ClientId = Tagged<"ClientId", string>
export type Cookie = Tagged<"Cookie", number | string>

/** Expected failures are protocol data, not Error instances requiring revival. */
export type RemoteUnavailableError = { error: "unavailable"; message: string }
export type RemoteInvalidRequestError = {
	error: "invalid-request"
	message: string
}
export type RemoteMutationGapError = {
	error: "mutation-gap"
	expectedMutationId: number
	receivedMutationId: number
}
export type RemoteRequestError =
	| RemoteUnavailableError
	| RemoteInvalidRequestError
export type PushResponse =
	| { ok: true }
	| RemoteRequestError
	| RemoteMutationGapError
export type PullResponse<Schema extends AnySchema> = {
	cookie: Cookie
	patch: Patch<Schema>
	/** The last processed mutation, or 0 before any were applied. */
	lastMutationId: MutationId
	/** The latest commit the pull's read reflects. Omit if pokes never carry records. */
	revision?: Revision
}

/**
 * Orders one server instance's commits. Revisions from different instances are
 * not comparable, like cookies.
 */
export type Revision = {
	/** Identifies the server instance that numbered the commit. */
	server: string
	commit: number
}

/** Records a commit changed inside the client's view, sent with a poke. */
export type PokePayload<Schema extends AnySchema = AnySchema> = {
	revision: Revision
	/** Full records after the commit. */
	set?: PatchSetOp<Schema>[]
	/** Records the client knew that the commit deleted or moved out of its view. */
	remove?: PatchRemoveOp<Schema>[]
	/** Text appended to records the client already has. */
	append?: PokeAppendOp<Schema>[]
}

/**
 * Text a commit appended to one string field of a record the client has. The
 * client applies it only to the exact value it extends, and otherwise waits
 * for the pull the poke starts.
 */
export type PokeAppendOp<Schema extends AnySchema = AnySchema> = {
	[Collection in CollectionName<Schema>]: {
		collection: Collection
		id: Schema[Collection]["id"]
		field: AppendableField<Schema[Collection]>
		/** The field's length before the append. */
		offset: number
		text: string
		/**
		 * The commit that last wrote the record before this append, or an
		 * earlier one. The record held the value the append extends from then on.
		 */
		after: Revision
	}
}[CollectionName<Schema>]

class RemoteResponseError extends errore.createTaggedError({
	name: "RemoteResponseError",
	message: "Remote $operation failed",
}) {}

export type ClientApi<Schema extends AnySchema = AnySchema> = {
	clientId: ClientId
	/**
	 * Asks the client to pull. A payload is shown immediately, and its pull
	 * waits until payloads stop arriving, up to a maximum delay. Settles when a
	 * pull that confirms the poke has finished. Never rejects.
	 */
	poke: (payload?: PokePayload<Schema>) => Promise<void>
}

export type RemoteApi<Schema extends AnySchema> = {
	connect(
		api: ClientApi<Schema>,
	): Promise<AsyncUnsubscribe | RemoteRequestError>
	push(args: {
		mutations: Mutation<Schema>[]
		clientId: ClientId
	}): Promise<PushResponse>
	pull(args: {
		clientId: ClientId
		cookie?: Cookie
		scanWindow: ScanWindow<Schema>
	}): Promise<PullResponse<Schema> | RemoteRequestError>
}

export type PatchSetOp<Schema extends AnySchema> = {
	[Collection in CollectionName<Schema>]: {
		collection: Collection
		value: Schema[Collection]
	}
}[CollectionName<Schema>]

export type PatchRemoveOp<Schema extends AnySchema> = {
	[Collection in CollectionName<Schema>]: {
		collection: Collection
		id: Schema[Collection]["id"]
	}
}[CollectionName<Schema>]

export type Patch<Schema extends AnySchema = AnySchema> = {
	/** Replace the confirmed replica with this snapshot before replaying pending writes. */
	reset?: boolean
	set?: PatchSetOp<Schema>[]
	remove?: PatchRemoveOp<Schema>[]
}

export namespace PatchApi {
	export function toString<Schema extends AnySchema>(
		patch: Patch<Schema>,
	): string {
		return `Patch {\n${
			patch.set
				?.map(
					(op) =>
						`  set ${op.collection}.${op.value.id} = ${JSON.stringify(op.value)}`,
				)
				.join("\n") ?? ""
		}\n${patch.remove?.map((op) => `  remove ${op.collection}.${op.id}`).join("\n") ?? ""}}`
	}
}

class PokeCodecInputError extends errore.createTaggedError({
	name: "PokeCodecInputError",
	message: "Invalid poke payload: $detail",
}) {}

function isRevision(value: unknown): value is Revision {
	return (
		isObject(value) &&
		typeof value.server === "string" &&
		Number.isSafeInteger(value.commit)
	)
}

export namespace PokeApi {
	/**
	 * Serialize poke payloads at transport boundaries, as `MutationApi.codec`
	 * does for pushes. Applies each collection's codec to records and identities.
	 */
	export function codec<Schema extends AnySchema>(
		schema: RuntimeSchemaDefinition<Schema>,
	): Codec<PokePayload<Schema>, unknown> {
		function transformOps(
			ops: unknown,
			field: "value" | "id",
			direction: "encode" | "decode",
		) {
			if (ops === undefined) return undefined
			if (!Array.isArray(ops))
				return new PokeCodecInputError({ detail: "expected an array" })
			const transformed: Record<string, unknown>[] = []
			for (const op of ops) {
				if (
					!isObject(op) ||
					typeof op.collection !== "string" ||
					!Object.hasOwn(schema.collections, op.collection)
				) {
					return new PokeCodecInputError({ detail: "unknown collection" })
				}
				const valueCodec = schema.collections[op.collection].codec
				// Field codecs are consumer code and can throw on invalid wire values.
				const value = errore.try({
					try: () => {
						if (!valueCodec) return op[field]
						if (field === "value") return valueCodec[direction](op.value)
						const identity = valueCodec[direction]({ id: op.id }) as {
							id: unknown
						}
						return identity.id
					},
					catch: (cause) =>
						new PokeCodecInputError({
							detail: "collection codec rejected input",
							cause,
						}),
				})
				if (value instanceof Error) return value
				transformed.push({ ...op, [field]: value })
			}
			return transformed
		}

		// The field's codec sees the appended text alone, as a partial record,
		// the way update payloads are encoded.
		function transformAppends(ops: unknown, direction: "encode" | "decode") {
			const identified = transformOps(ops, "id", direction)
			if (identified === undefined || identified instanceof Error)
				return identified
			const transformed: Record<string, unknown>[] = []
			for (const op of identified) {
				if (
					typeof op.field !== "string" ||
					op.field === "id" ||
					!Number.isSafeInteger(op.offset) ||
					(op.offset as number) < 0 ||
					typeof op.text !== "string" ||
					!isRevision(op.after)
				) {
					return new PokeCodecInputError({ detail: "invalid append" })
				}
				const { field, text } = op
				const valueCodec = schema.collections[op.collection as string].codec
				const output = errore.try({
					try: () =>
						valueCodec
							? valueCodec[direction]({ [field]: text })
							: { [field]: text },
					catch: (cause) =>
						new PokeCodecInputError({
							detail: "collection codec rejected input",
							cause,
						}),
				})
				if (output instanceof Error) return output
				if (!isObject(output) || typeof output[field] !== "string")
					return new PokeCodecInputError({
						detail: "appended text must stay a string",
					})
				transformed.push({ ...op, text: output[field] })
			}
			return transformed
		}

		function transform(input: unknown, direction: "encode" | "decode") {
			if (!isObject(input) || !isRevision(input.revision)) {
				return new PokeCodecInputError({ detail: "expected a revision" })
			}
			const set = transformOps(input.set, "value", direction)
			if (set instanceof Error) return set
			const remove = transformOps(input.remove, "id", direction)
			if (remove instanceof Error) return remove
			const append = transformAppends(input.append, direction)
			if (append instanceof Error) return append
			return {
				revision: input.revision,
				...(set ? { set } : {}),
				...(remove ? { remove } : {}),
				...(append ? { append } : {}),
			}
		}

		return createCodec(
			"PokePayload",
			(input) => {
				const output = transform(input, "encode")
				if (output instanceof Error) throw output
				return output
			},
			(input) => {
				const output = transform(input, "decode")
				if (output instanceof Error) throw output
				return output as PokePayload<Schema>
			},
		)
	}
}

export type SyncEngineArgs<Schema extends AnySchema> = {
	remote: SyncEngine<Schema>["remote"]
	db: SyncEngine<Schema>["db"]
	autoConnect?: boolean
	logger: SyncEngine<Schema>["logger"]
	syncInterval: number | TimerApi
	livePullDelay: number | TimerApi
	livePullMaxDelay: number | TimerApi
	rng?: RngApi
}

/** Live payloads whose confirming pull waits for the stream to go quiet. */
type DeferredPull = {
	confirmed: PromiseWithResolvers<void>
	/** Whether a payload arrived since the last quiet check. */
	busy: boolean
}

function toTimer(interval: number | TimerApi): TimerApi {
	return typeof interval === "number" ? new Timer({ interval }) : interval
}

export class SyncEngine<Schema extends AnySchema> {
	private syncQueue: TaskQueue<"pull" | "push">
	private readonly db: Database<Schema>
	private readonly remote: RemoteApi<Schema>
	private readonly logger: LoggerApi
	private readonly rng: RngApi
	private readonly livePullDelay: TimerApi
	private readonly livePullMaxDelay: TimerApi
	private deferredPull?: DeferredPull

	private disconnectFromRemote?: AsyncUnsubscribe
	// Advances on disconnect so a connect still in flight unregisters when it resolves.
	private connectionGeneration = 0
	private scanWindow: ScanWindow<Schema> = []

	get clientId(): ClientId {
		return this.db.replica.clientId
	}

	constructor(args: SyncEngineArgs<Schema>) {
		this.logger = args.logger
		this.remote = args.remote
		this.db = args.db
		this.rng = args.rng ?? { randomId }
		const timer = toTimer(args.syncInterval)
		this.livePullDelay = toTimer(args.livePullDelay)
		this.livePullMaxDelay = toTimer(args.livePullMaxDelay)

		this.syncQueue = new TaskQueue(
			{
				pull: async () => {
					const result = await this.pull()
					if (result instanceof Error) throw result
				},
				push: async () => {
					const result = await this.push()
					if (result instanceof Error) throw result
				},
			},
			timer,
		)

		if (args.autoConnect) {
			this.connect().catch((error) => {
				// TODO: disconnect and operate in offline mode
				this.logger.error({ message: "error connecting to remote", error })
			})
		}
	}

	async connect(): Promise<AsyncUnsubscribe> {
		const connected = await this.connectToRemote()
		if (connected instanceof Error) throw connected
		await this.queuePull()
		if (this.db.outbox.scan({ limit: 1 }).length) {
			await this.syncQueue.enqueue("push")
		}
		return () => this.disconnect()
	}

	private async connectToRemote() {
		this.logger.info({ message: "connecting to remote" })
		const generation = this.connectionGeneration
		if (!this.db.isReady) await this.db.ready
		// Clear can rotate identity during either await; connect the new durable session instead.
		for (;;) {
			const clientId = this.clientId
			const checkpoint = await this.db.persistClientStorage()
			if (checkpoint instanceof Error) return checkpoint
			if (clientId !== this.clientId) continue
			const unsubscribe = await this.remote.connect({
				clientId,
				poke: (payload) => {
					if (clientId !== this.clientId) return Promise.resolve()
					this.logger.info({ message: "received poke from remote" })
					// Like pulls, live records only apply while connected.
					const live = payload && this.disconnectFromRemote
					if (live) this.db.applyPoke(payload)
					const pulled = live
						? this.deferPull()
						: this.queuePull().catch((error) => {
								this.logger.error({
									message: "error pulling from remote",
									error,
								})
							})
					if (!live) return pulled
					// The pull can fail before saving, so wait for the live checkpoint
					// too. The storage subscriber already logs a failed save.
					return Promise.all([pulled, this.db.persistClientStorage()]).then(
						() => undefined,
					)
				},
			})
			if (typeof unsubscribe !== "function") {
				return new RemoteResponseError({
					operation: "connect",
					cause: unsubscribe,
				})
			}
			if (generation !== this.connectionGeneration) {
				await unsubscribe()
				return
			}
			if (clientId !== this.clientId) {
				await unsubscribe()
				continue
			}
			// Overlapping connect calls keep only the newest registration.
			const previous = this.disconnectFromRemote
			this.disconnectFromRemote = unsubscribe
			await previous?.()

			this.logger.info({ message: "connected to remote" })
			return
		}
	}

	async disconnect() {
		this.logger.info({ message: "disconnecting from remote" })
		this.connectionGeneration += 1
		const unsubscribe = this.disconnectFromRemote
		this.disconnectFromRemote = undefined
		await unsubscribe?.()
	}

	subscribe(query: EncodedQuery<Schema>): Unsubscribe {
		this.logger.info({ message: "subscribing to query", query })
		this.scanWindow.push(query)
		void this.queuePull().catch((error) => {
			this.logger.error({ message: "error pulling from remote", error })
		})

		return () => {
			this.logger.info({ message: "unsubscribing from query", query })
			this.scanWindow.splice(this.scanWindow.indexOf(query), 1)
		}
	}

	queuePull(): Promise<void> {
		this.logger.info({ message: "queueing pull" })
		return this.syncQueue.enqueue("pull").then(() => {
			this.logger.info({ message: "pull finished" })
		})
	}

	/**
	 * Pulls once live payloads stop arriving for `livePullDelay`, or once
	 * `livePullMaxDelay` has passed since the first of them. Any pull that
	 * starts sooner confirms them instead.
	 */
	private deferPull(): Promise<void> {
		if (this.deferredPull) {
			this.deferredPull.busy = true
			return this.deferredPull.confirmed.promise
		}
		const deferred: DeferredPull = {
			confirmed: Promise.withResolvers(),
			busy: false,
		}
		this.deferredPull = deferred
		const pull = () => {
			if (this.deferredPull !== deferred) return
			// pull() settles the deferral whatever the outcome.
			this.queuePull().catch((error) => {
				this.logger.error({ message: "error pulling from remote", error })
			})
		}
		const waitForQuiet = () => {
			void this.livePullDelay.waitForNextTick().then(() => {
				if (!deferred.busy) return pull()
				deferred.busy = false
				waitForQuiet()
			})
		}
		waitForQuiet()
		void this.livePullMaxDelay.waitForNextTick().then(pull)
		return deferred.confirmed.promise
	}

	private async pull() {
		// The request reads every commit whose payload already arrived.
		const deferred = this.deferredPull
		this.deferredPull = undefined
		using settle = new errore.DisposableStack()
		settle.defer(() => deferred?.confirmed.resolve())
		return await this.pullFromRemote()
	}

	private async pullFromRemote() {
		if (!this.disconnectFromRemote) {
			return
		}

		this.logger.info({ message: "pulling from remote" })
		const clientId = this.clientId
		const response = await this.remote.pull({
			clientId,
			cookie: this.db.replica.cookie,
			// Subscriptions change this array in place; send what this pull reads.
			scanWindow: [...this.scanWindow],
		})
		// A response from before clear() must not acknowledge the new session.
		if (clientId !== this.clientId) return
		// A response that arrives after disconnect is dropped; the next connect pulls again.
		if (!this.disconnectFromRemote) return
		if ("error" in response) {
			return new RemoteResponseError({ operation: "pull", cause: response })
		}
		const { cookie, patch, lastMutationId } = response

		this.logger.info({
			message: "pulled from remote",
			cookie,
			lastMutationId,
			patch: PatchApi.toString(patch),
		})

		this.db.applyPull(response)
		return this.db.persistClientStorage()
	}

	commit(
		transaction: Transaction<Schema>,
		forwarded?: { clientId: ClientId; mutationId: MutationId },
	): Promise<void> {
		const clientId = this.clientId
		this.db.commitMutation(transaction, forwarded)
		const pendingCheckpoint = this.db.persistClientStorage()
		if (!pendingCheckpoint) return this.syncQueue.enqueue("push")
		return pendingCheckpoint.then((checkpoint) => {
			if (checkpoint instanceof Error) throw checkpoint
			if (clientId !== this.clientId) return
			this.logger.info({ message: "queueing push" })
			return this.syncQueue.enqueue("push")
		})
	}

	/** Push pending mutations without waiting for another commit. */
	queuePush(): Promise<void> {
		return this.syncQueue.enqueue("push")
	}

	private async push() {
		const clientId = this.clientId
		const mutations = this.db.outbox.scan().map(({ key, value }) => ({
			id: key[0],
			ops: value,
		}))
		if (!mutations.length) return

		// A queued push can capture mutations newer than the commit that requested it.
		const checkpoint = await this.db.flushClientStorage()
		if (checkpoint instanceof Error) return checkpoint
		if (clientId !== this.clientId) return
		if (!this.disconnectFromRemote) {
			this.logger.info({ message: "skipping push while disconnected" })
			return
		}

		const response = await this.remote.push({
			mutations,
			clientId,
		})
		if ("error" in response) {
			return new RemoteResponseError({ operation: "push", cause: response })
		}
	}

	async clear() {
		const unsubscribe = this.disconnectFromRemote
		this.disconnectFromRemote = undefined
		const [checkpoint] = await Promise.all([
			this.db.clear(tag<ClientId>(this.rng.randomId())),
			unsubscribe?.(),
		])
		if (checkpoint instanceof Error) throw checkpoint
		// Preserve connection state, but leave the database empty until a later pull.
		if (!unsubscribe) return
		const connected = await this.connectToRemote()
		if (connected instanceof Error) throw connected
	}
}
