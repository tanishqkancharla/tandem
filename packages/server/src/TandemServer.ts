import type {
	AnySchema,
	AnyMutators,
	ClientApi,
	ClientId,
	CollectionName,
	Cookie,
	Json,
	Mutation,
	MutationId,
	MutationOp,
	MutationRejection,
	MutatorArgs,
	MutatorArgsOf,
	MutateApi,
	MutatorCall,
	MutatorContext,
	MutatorTransaction,
	PatchRemoveOp,
	PatchSetOp,
	PokePayload,
	RelationalQuery,
	RelationalQueryResult,
	RemoteApi,
	RemoteInvalidRequestError,
	RemoteMutationGapError,
	Revision,
	RngApi,
	AnyRelations,
	RuntimeSchemaDefinition,
	ScanWindow,
	SchemaToTupleSchema,
	TimerApi,
} from "@tanishqkancharla/tandem-core"
import { tag, unreachable } from "@tanishqkancharla/tandem-core"
import {
	collectionIdToTuple,
	executeQueryAsync,
	executeScanWindowAsync,
	InvalidScanWindowError,
	scanWindowOffsetCollections,
	selectScanWindowRecordsAsync,
	UpdatePayloadError,
	validateMutatorArgs,
} from "@tanishqkancharla/tandem-core/internal"
import type { ScanWindowRecord } from "@tanishqkancharla/tandem-core/internal"
import * as errore from "errore"
import {
	AsyncTupleDatabase,
	AsyncTupleDatabaseClient,
	subscribeQueryAsync,
} from "tuple-database"
import type {
	AsyncTupleRootTransactionApi,
	AsyncTupleStorageApi,
	ReadOnlyAsyncTupleDatabaseClientApi,
	WriteOps,
} from "tuple-database"
import { LivePayloadBuffer } from "./LivePayloadBuffer.js"
import { TandemServerError } from "./TandemServerError.js"
import { TandemServerTransaction } from "./TandemServerTransaction.js"
import type {
	TandemClientTuple,
	TandemTuple,
	TandemServerStorageApi,
} from "./storage/TandemServerStorage.js"

export type TandemServerArgs<
	Schema extends AnySchema,
	Relations extends AnyRelations<Schema>,
	Mutators extends AnyMutators<Schema> = {},
	RequestContext = unknown,
> = {
	schema: RuntimeSchemaDefinition<Schema>
	relations: Relations
	storage: TandemServerStorageApi<NoInfer<Schema>>
	mutators?: Mutators
	hooks?: (
		request: RequestContext | undefined,
	) => ServerMutatorHooks<Schema, Relations, Mutators>
	rng?: RngApi
	/**
	 * Milliseconds, or a host-provided timer, during which a client's live
	 * payloads merge after one is sent. `0` sends every commit's payload.
	 * @default 50
	 */
	livePokeInterval?: number | TimerApi
}

export type TandemServerSubscription<Result> = {
	result: Result
	destroy: () => void
}

export type TandemServerSubscriptionOptions = {
	onError?: (error: Error) => void
}

type SyncedRecordKey<
	Schema extends AnySchema,
	Collection extends CollectionName<Schema> = CollectionName<Schema>,
> = {
	[CurrentCollection in Collection]: {
		collection: CurrentCollection
		id: Schema[CurrentCollection]["id"]
	}
}[Collection]

type SyncClientState<Schema extends AnySchema> = {
	// Reconnects and tabs sharing a client identity can overlap connections.
	pokes: Set<ClientApi<Schema>["poke"]>
	cookie?: Cookie
	/** Records the latest pull returned, by record ID. */
	syncedRecords?: Map<string, SyncedRecordKey<Schema>>
	/** A copy of the latest pull's window. Live pokes only carry records inside it. */
	scanWindow?: ScanWindow<Schema>
	/** Record IDs sent in poke payloads since the latest pull. */
	liveRecordIds: Set<string>
	/** Changes for the client's next live payload. */
	buffer: LivePayloadBuffer<Schema>
	/** Whether a payload went out this interval, so changes wait for its end. */
	throttled: boolean
}

/** Request identity available to authorization and post-commit work. */
export type ServerMutatorContext = {
	location: "server"
	clientId: ClientId
	mutationId: MutationId
} & { source: "client" | "server" }

type ServerMutator<
	Schema extends AnySchema,
	Relations extends AnyRelations<Schema>,
	Args = Json,
> = {
	args: MutatorArgs<Json, Args>
	run: (
		tx: MutatorTransaction<Schema>,
		args: Args,
		ctx: MutatorContext,
	) => unknown
	authorize?: (
		tx: TandemServerTransaction<Schema, Relations>,
		args: Args,
		ctx: ServerMutatorContext,
	) => unknown
	afterCommit?: (args: Args, ctx: ServerMutatorContext) => unknown
}

type ServerMutators<
	Schema extends AnySchema,
	Relations extends AnyRelations<Schema>,
> = {
	// oxlint-disable-next-line typescript/no-explicit-any
	[name: string]: ServerMutator<Schema, Relations, any>
}

/** Contextually types the hooks for a registry of shared definitions. */
export type ServerMutatorHooks<
	Schema extends AnySchema,
	Relations extends AnyRelations<Schema>,
	Shared extends AnyMutators<Schema>,
> = {
	[Name in keyof Shared]?: {
		authorize?: (
			tx: TandemServerTransaction<Schema, Relations>,
			args: MutatorArgsOf<Shared[Name]>,
			ctx: ServerMutatorContext,
		) => unknown
		afterCommit?: (
			args: MutatorArgsOf<Shared[Name]>,
			ctx: ServerMutatorContext,
		) => unknown
	}
}

export type TandemServerPushOptions<RequestContext = unknown> = {
	context?: RequestContext
	/** Raw operation pushes are refused by default when mutators are registered. */
	allowOps?: boolean
}

class MutatorRunError extends errore.createTaggedError({
	name: "MutatorRunError",
	message: "Mutator $mutator threw",
}) {}

function rejectionMessage(error: unknown) {
	return error instanceof Error ? error.message : String(error)
}
/** How many recently written records keep their exact last write. */
const trackedWrites = 10_000

type CommitOptions =
	| { operation: "commit" }
	| { operation: "push"; clientId: ClientId }

/** Records one commit changed, read in the run queue right after it. */
type CommitChanges<Schema extends AnySchema> = {
	revision: Revision
	/** Full records after the commit, including appended ones. */
	set: PatchSetOp<Schema>[]
	remove: PatchRemoveOp<Schema>[]
	/** Records the commit changed only by appending, by record ID. */
	append: Map<string, DerivedAppend<Schema> & { after: Revision }>
	/** The client whose push made the commit. It pulls to acknowledge it. */
	pusher?: ClientId
}

type DerivedAppend<Schema extends AnySchema> = {
	collection: CollectionName<Schema>
	id: Schema[CollectionName<Schema>]["id"]
	fields: { field: string; offset: number; text: string }[]
}

/** Compare only plain data whose equality we can prove without serialization. */
function safelyEqual(
	before: unknown,
	after: unknown,
	seen = new WeakSet<object>(),
): boolean {
	if (Object.is(before, after)) return true
	if (
		before === null ||
		after === null ||
		typeof before !== "object" ||
		typeof after !== "object"
	)
		return false
	if (seen.has(before) || seen.has(after)) return false
	seen.add(before)
	seen.add(after)
	if (Array.isArray(before) !== Array.isArray(after)) return false
	if (
		Object.getPrototypeOf(before) !==
			(Array.isArray(before) ? Array.prototype : Object.prototype) ||
		Object.getPrototypeOf(after) !==
			(Array.isArray(after) ? Array.prototype : Object.prototype)
	)
		return false
	const beforeKeys = Reflect.ownKeys(before)
	const afterKeys = Reflect.ownKeys(after)
	if (beforeKeys.length !== afterKeys.length) return false
	const beforeFields = Object.getOwnPropertyDescriptors(before)
	const afterFields = Object.getOwnPropertyDescriptors(after)
	return beforeKeys.every((key) => {
		const left = beforeFields[key as keyof typeof beforeFields]
		const right = afterFields[key as keyof typeof afterFields]
		return (
			left &&
			right &&
			"value" in left &&
			"value" in right &&
			safelyEqual(left.value, right.value, seen)
		)
	})
}

function appendedFields(
	previous: Record<string, unknown> | undefined,
	next: Record<string, unknown>,
): DerivedAppend<AnySchema>["fields"] | undefined {
	if (!previous) return
	const fields: DerivedAppend<AnySchema>["fields"] = []
	for (const field of new Set([
		...Object.keys(previous),
		...Object.keys(next),
	])) {
		const before = previous[field]
		const after = next[field]
		const existed = Object.hasOwn(previous, field)
		const exists = Object.hasOwn(next, field)
		if (existed && exists && safelyEqual(before, after)) continue
		const prefix = before ?? ""
		if (
			field === "id" ||
			typeof prefix !== "string" ||
			typeof after !== "string" ||
			!after.startsWith(prefix) ||
			after.length === prefix.length
		)
			return
		fields.push({
			field,
			offset: prefix.length,
			text: after.slice(prefix.length),
		})
	}
	return fields.length ? fields : undefined
}

function scanWindowRecordToKey<
	Schema extends AnySchema,
	Collection extends CollectionName<Schema>,
>(
	record: ScanWindowRecord<Schema, Collection>,
): SyncedRecordKey<Schema, Collection> {
	return { collection: record.collection, id: record.value.id }
}

function recordId<Schema extends AnySchema>(key: SyncedRecordKey<Schema>) {
	return JSON.stringify([key.collection, ...collectionIdToTuple(key.id)])
}

async function applyMutationOperation<
	Schema extends AnySchema,
	Relations extends AnyRelations<Schema>,
>(
	transaction: TandemServerTransaction<Schema, Relations>,
	operation: MutationOp<Schema>,
): Promise<TandemServerError | RemoteInvalidRequestError | undefined> {
	switch (operation.type) {
		case "set":
			return errore.try({
				try: () => {
					transaction.set(operation.collection, operation.value)
					return undefined
				},
				catch: (cause) => new TandemServerError({ operation: "push", cause }),
			})
		case "remove":
			return errore.try({
				try: () => {
					transaction.remove(operation.collection, operation.id)
					return undefined
				},
				catch: (cause) => new TandemServerError({ operation: "push", cause }),
			})
		case "update": {
			const updated = await transaction
				.update(operation.collection, operation.id, operation.payload)
				.catch((cause) =>
					cause instanceof UpdatePayloadError
						? cause
						: new TandemServerError({ operation: "push", cause }),
				)
			if (updated instanceof UpdatePayloadError) {
				return {
					error: "invalid-request",
					message: updated.message,
				}
			}
			if (updated instanceof Error) return updated
			return
		}
		default:
			return unreachable(operation)
	}
}

/**
 * Errors storage adapters threw. A server mutator that hits one has not refused
 * its mutation, so the mutation stays pending instead of being rejected. Marked
 * rather than wrapped, so callers still see the adapter's error as the cause.
 */
const storageFailures = new WeakSet<object>()

function isStorageFailure(error: unknown): boolean {
	const seen = new Set<unknown>()
	for (let current = error; current instanceof Error; current = current.cause) {
		if (seen.has(current)) return false
		seen.add(current)
		if (storageFailures.has(current)) return true
	}
	return false
}

function tandemStorageToTupleDatabaseStorage<Schema extends AnySchema>(
	storage: TandemServerStorageApi<Schema>,
): AsyncTupleStorageApi {
	const mark = (cause: unknown) => {
		if (typeof cause === "object" && cause !== null) storageFailures.add(cause)
		throw cause
	}
	return {
		scan: (args) => storage.scan(args).catch(mark),
		commit: (writes) =>
			storage.commit(writes as WriteOps<TandemTuple<Schema>>).catch(mark),
		close: () => storage.close(),
	}
}

export class TandemServer<
	Schema extends AnySchema,
	Relations extends AnyRelations<Schema>,
	Mutators extends AnyMutators<Schema> = {},
	RequestContext = unknown,
> implements RemoteApi<Schema> {
	private readonly relations: Relations
	private readonly mutators?: Mutators
	/** Server-owned named calls, bound to this instance at registration. */
	readonly mutate: MutateApi<Mutators>
	private readonly hooks?: TandemServerArgs<
		Schema,
		Relations,
		Mutators,
		RequestContext
	>["hooks"]
	private readonly subscriptions = new Set<() => void>()
	private readonly syncClients = new Map<ClientId, SyncClientState<Schema>>()
	private readonly schema: RuntimeSchemaDefinition<Schema>
	private readonly tupleDb: AsyncTupleDatabaseClient<TandemTuple<Schema>>
	private readonly rng?: RngApi
	private readonly livePokeTimer?: TimerApi
	private readonly unsubscribeStorage?: () => void
	// Revisions are per instance, like cookies; a restart starts a new sequence.
	private readonly instanceId: string
	private directMutationId = 0
	private commitCount = 0
	// The commit that last wrote each recently written record, oldest first.
	// An append extends the value a record has had since then.
	private readonly lastWrites = new Map<string, number>()
	// Records missing from lastWrites last changed at or before this commit.
	private forgottenWritesThrough = 0
	// Set while this instance commits, to tell its own writes from others'.
	private committing = false
	private closed = false
	// Tuple transactions batch writes but do not snapshot reads or serialize
	// asynchronous storage commits. Order sync reads and commits here.
	private queue: Promise<void> = Promise.resolve()

	constructor(
		args: TandemServerArgs<Schema, Relations, Mutators, RequestContext>,
	) {
		this.schema = args.schema
		this.relations = args.relations
		this.mutators = args.mutators
		this.hooks = args.hooks
		this.mutate = Object.fromEntries(
			Object.keys(args.mutators ?? {}).map((name) => [
				name,
				(input: Json) => this.runNamedMutator(name, input),
			]),
		) as unknown as MutateApi<Mutators>
		this.rng = args.rng
		const livePokeInterval = args.livePokeInterval ?? 50
		this.livePokeTimer =
			typeof livePokeInterval !== "number"
				? livePokeInterval
				: livePokeInterval > 0
					? {
							waitForNextTick: () =>
								new Promise((resolve) => setTimeout(resolve, livePokeInterval)),
						}
					: undefined
		this.instanceId = args.rng?.randomId() ?? crypto.randomUUID()
		const database = new AsyncTupleDatabase(
			tandemStorageToTupleDatabaseStorage(args.storage),
			{ rng: args.rng },
		)
		this.tupleDb = new AsyncTupleDatabaseClient<TandemTuple<Schema>>(database)
		this.unsubscribeStorage = args.storage.subscribe?.(() => {
			// This instance's own commits poke clients themselves.
			if (this.closed || this.committing) return
			this.forgetLastWrites()
			this.emitPokes()
		})
	}

	private get recordDb() {
		// Query APIs retain full ["record", ...] keys. This is the same client,
		// narrowed for those APIs, not a subspace that strips the record prefix.
		return this.tupleDb as unknown as AsyncTupleDatabaseClient<
			SchemaToTupleSchema<Schema>
		>
	}

	transact(): TandemServerTransaction<Schema, Relations> {
		return new TandemServerTransaction(
			this.tupleDb.transact(this.rng?.randomId()),
			this.relations,
		)
	}

	commit(
		transaction: TandemServerTransaction<Schema, Relations>,
	): Promise<void> {
		return this.run(() =>
			this.commitTransaction(transaction, { operation: "commit" }),
		)
	}

	private registered(
		name: string,
		request?: RequestContext,
	): ServerMutators<Schema, Relations>[string] | Error | undefined {
		if (!this.mutators || !Object.hasOwn(this.mutators, name)) return
		const hooks = errore.try({
			try: () => this.hooks?.(request)?.[name as keyof Mutators],
			catch: (cause) => new MutatorRunError({ mutator: name, cause }),
		})
		if (hooks instanceof Error) return hooks
		return {
			...this.mutators[name as keyof Mutators],
			...(hooks?.authorize && { authorize: hooks.authorize }),
			...(hooks?.afterCommit && { afterCommit: hooks.afterCommit }),
		} as ServerMutators<Schema, Relations>[string]
	}

	/** Run a registered named mutator for server-owned work such as a stream chunk. */
	private runNamedMutator(name: string, input: Json): Promise<void> {
		return this.run(async () => {
			const definition = this.registered(name)
			if (definition instanceof Error) return definition
			if (!definition) return new Error(`Unknown mutator ${name}`)
			const args = await validateMutatorArgs(name, definition.args, input)
			if (args instanceof Error) return args
			const transaction = this.transact()
			const context: ServerMutatorContext = {
				location: "server",
				source: "server",
				clientId: this.instanceId as unknown as ClientId,
				mutationId: tag<MutationId>(++this.directMutationId),
			}
			const ran = await Promise.resolve()
				.then(async () => {
					const authorized = await definition.authorize?.(
						transaction,
						args,
						context,
					)
					if (authorized instanceof Error) return authorized
					return definition.run(transaction, args, context)
				})
				.catch(
					(cause: unknown) => new MutatorRunError({ mutator: name, cause }),
				)
			if (ran instanceof Error) {
				await transaction.cancel()
				return ran
			}
			const committed = await this.commitTransaction(transaction, {
				operation: "commit",
			})
			if (committed instanceof Error) return committed
			if (definition.afterCommit)
				this.runEffect(() => definition.afterCommit!(args, context))
		}).then(() => undefined)
	}

	connect = ({ clientId, poke }: ClientApi<Schema>) => {
		// Wrap so each connection unregisters only itself, even if callers reuse a callback.
		const connection: ClientApi<Schema>["poke"] = (payload) => poke(payload)
		this.getSyncClient(clientId).pokes.add(connection)

		return Promise.resolve(() => {
			const client = this.syncClients.get(clientId)
			client?.pokes.delete(connection)
			// Forget the view with the last connection. Pokes carry no records
			// again until a pull, which the transport authorizes, records a view.
			if (client?.pokes.size === 0) this.syncClients.delete(clientId)
			return Promise.resolve()
		})
	}

	push = (
		{ clientId, mutations }: Parameters<RemoteApi<Schema>["push"]>[0],
		options: TandemServerPushOptions<RequestContext> = {},
	): ReturnType<RemoteApi<Schema>["push"]> =>
		this.run(async () => {
			const result = await this.applyPush(clientId, mutations, options)
			if (result instanceof Error) {
				return { error: "unavailable", message: result.message } as const
			}
			return result
		})

	pull: RemoteApi<Schema>["pull"] = (args) =>
		this.run(async () => {
			const result = await this.readPull(args)
			if (result instanceof Error) {
				return { error: "unavailable", message: result.message } as const
			}
			return result
		})

	private run<T>(operation: () => Promise<T | TandemServerError>): Promise<T> {
		const result = this.queue.then(async () => {
			const value = await operation()
			if (value instanceof Error) throw value
			return value
		})
		this.queue = result.then(
			() => undefined,
			() => undefined,
		)
		return result
	}

	async query<Query extends RelationalQuery<Schema, Relations>>(
		query: Query,
	): Promise<RelationalQueryResult<Schema, Relations, Query>> {
		const result = await this.runQuery(this.recordDb, query, "query")
		if (result instanceof Error) throw result
		return result
	}

	async subscribe<Query extends RelationalQuery<Schema, Relations>>(
		query: Query,
		callback: (result: RelationalQueryResult<Schema, Relations, Query>) => void,
		options: TandemServerSubscriptionOptions = {},
	): Promise<
		TandemServerSubscription<RelationalQueryResult<Schema, Relations, Query>>
	> {
		const subscription = await subscribeQueryAsync(
			this.recordDb,
			(db) => this.runQuery(db, query, "subscribe"),
			(result) => {
				if (result instanceof Error) {
					if (options.onError) options.onError(result)
					else console.error(result)
					return
				}
				callback(result)
			},
		).catch((cause) => new TandemServerError({ operation: "subscribe", cause }))

		if (subscription instanceof Error) throw subscription
		if (subscription.result instanceof Error) {
			subscription.destroy()
			throw subscription.result
		}

		let destroyed = false
		const destroy = () => {
			if (destroyed) return
			destroyed = true
			subscription.destroy()
			this.subscriptions.delete(destroy)
		}
		this.subscriptions.add(destroy)

		return { result: subscription.result, destroy }
	}

	async close(): Promise<void> {
		this.closed = true
		this.unsubscribeStorage?.()
		for (const destroy of this.subscriptions) destroy()
		this.syncClients.clear()

		const result = await this.tupleDb
			.close()
			.catch((cause) => new TandemServerError({ operation: "close", cause }))
		if (result instanceof Error) throw result
	}

	private runQuery<Query extends RelationalQuery<Schema, Relations>>(
		db: ReadOnlyAsyncTupleDatabaseClientApi<SchemaToTupleSchema<Schema>>,
		query: Query,
		operation: "query" | "subscribe",
	): Promise<
		TandemServerError | RelationalQueryResult<Schema, Relations, Query>
	> {
		return executeQueryAsync<Schema, Relations, Query>(
			db,
			this.relations,
			query,
		).catch((cause) => new TandemServerError({ operation, cause }))
	}

	private getSyncClient(clientId: ClientId): SyncClientState<Schema> {
		const current = this.syncClients.get(clientId)
		if (current) return current

		const created: SyncClientState<Schema> = {
			pokes: new Set(),
			liveRecordIds: new Set(),
			buffer: new LivePayloadBuffer(),
			throttled: false,
		}
		this.syncClients.set(clientId, created)
		return created
	}

	private async applyPush(
		clientId: ClientId,
		mutations: Mutation<Schema>[],
		{
			context,
			allowOps = this.mutators === undefined,
		}: TandemServerPushOptions<RequestContext>,
	): Promise<
		| TandemServerError
		| RemoteInvalidRequestError
		| RemoteMutationGapError
		| { ok: true; rejected?: MutationRejection[] }
	> {
		const rejected: MutationRejection[] = []
		const accepted = () =>
			({
				ok: true,
				...(rejected.length ? { rejected } : {}),
			}) as const
		for (const mutation of mutations) {
			const lastMutationId = await this.readLastMutationId(clientId, "push")
			if (lastMutationId instanceof Error) return lastMutationId
			if (mutation.id <= lastMutationId) continue
			if (mutation.id !== lastMutationId + 1) {
				return {
					error: "mutation-gap",
					expectedMutationId: lastMutationId + 1,
					receivedMutationId: mutation.id,
				}
			}
			if (mutation.mutator) {
				const outcome = await this.applyMutator(
					clientId,
					mutation.id,
					mutation.mutator,
					context,
				)
				if (outcome instanceof Error) return outcome
				if (outcome) rejected.push(outcome)
				continue
			}
			if (!allowOps) {
				const outcome = await this.reject(
					clientId,
					mutation.id,
					"This server accepts only named mutations",
				)
				if (outcome instanceof Error) return outcome
				rejected.push(outcome)
				continue
			}

			const { transaction, acknowledge } = this.pushTransaction(clientId)
			for (const operation of mutation.ops) {
				const staged = await applyMutationOperation(transaction, operation)
				if (staged !== undefined) {
					await transaction.cancel()
					return staged
				}
			}
			const acknowledged = acknowledge(mutation.id)
			if (acknowledged instanceof Error) {
				await transaction.cancel()
				return acknowledged
			}

			const committed = await this.commitTransaction(transaction, {
				operation: "push",
				clientId,
			})
			if (committed instanceof Error) return committed
		}
		return accepted()
	}

	/**
	 * Runs a named mutation and commits its writes with the client's
	 * acknowledgement. A refusal is acknowledged with no effect and returned;
	 * a storage failure is returned as an error so the client retries.
	 */
	private async applyMutator(
		clientId: ClientId,
		mutationId: MutationId,
		call: MutatorCall,
		request: RequestContext | undefined,
	): Promise<TandemServerError | MutationRejection | undefined> {
		const definition = this.registered(call.name, request)
		if (definition instanceof Error)
			return this.reject(clientId, mutationId, definition.message)
		if (!definition)
			return this.reject(clientId, mutationId, `Unknown mutator ${call.name}`)
		const args = await validateMutatorArgs(
			call.name,
			definition.args,
			call.args,
		)
		if (args instanceof Error)
			return this.reject(clientId, mutationId, args.message)

		const { transaction, acknowledge } = this.pushTransaction(clientId)
		const context: ServerMutatorContext = {
			location: "server",
			source: "client",
			clientId,
			mutationId,
		}
		// Authorization reads the same transaction before any shared writes commit.
		const ran = await Promise.resolve()
			.then(async () => {
				const authorized = await definition.authorize?.(
					transaction,
					args,
					context,
				)
				if (authorized instanceof Error) return authorized
				return definition.run(transaction, args, context)
			})
			.catch(
				(cause: unknown) => new MutatorRunError({ mutator: call.name, cause }),
			)
		if (ran instanceof Error) {
			const cancelled = await transaction
				.cancel()
				.catch((cause) => new TandemServerError({ operation: "push", cause }))
			if (cancelled instanceof Error) return cancelled
			// A storage failure is not a refusal; leave the mutation pending.
			const cause = ran instanceof MutatorRunError ? ran.cause : ran
			if (isStorageFailure(cause))
				return new TandemServerError({ operation: "push", cause })
			return this.reject(clientId, mutationId, rejectionMessage(cause))
		}
		const acknowledged = acknowledge(mutationId)
		if (acknowledged instanceof Error) {
			await transaction.cancel()
			return acknowledged
		}
		const committed = await this.commitTransaction(transaction, {
			operation: "push",
			clientId,
		})
		if (committed instanceof Error) return committed
		if (definition.afterCommit)
			this.runEffect(() => definition.afterCommit!(args, context))
	}

	/** Acknowledges a mutation without applying it, so it never blocks the client. */
	private async reject(
		clientId: ClientId,
		mutationId: MutationId,
		message: string,
	): Promise<TandemServerError | MutationRejection> {
		const { transaction, acknowledge } = this.pushTransaction(clientId)
		const acknowledged = acknowledge(mutationId)
		if (acknowledged instanceof Error) {
			await transaction.cancel()
			return acknowledged
		}
		// The pusher is poked even without record changes, so it pulls the rollback.
		const committed = await this.commitTransaction(transaction, {
			operation: "push",
			clientId,
		})
		if (committed instanceof Error) return committed
		return { id: mutationId, message }
	}

	private pushTransaction(clientId: ClientId) {
		const tupleTx = this.tupleDb.transact(this.rng?.randomId())
		const transaction = new TandemServerTransaction(tupleTx, this.relations)
		// Narrow before selecting the namespace: tuple-database cannot resolve
		// subspace types through the generic application-record union.
		const clientTx = (
			tupleTx as unknown as AsyncTupleRootTransactionApi<TandemClientTuple>
		).subspace(["client"])
		const acknowledge = (mutationId: MutationId) => {
			const staged = errore.try(() =>
				clientTx.set([clientId], { lastMutationId: mutationId }),
			)
			return staged instanceof Error
				? new TandemServerError({ operation: "push", cause: staged })
				: undefined
		}
		return { transaction, acknowledge }
	}

	private runEffect(effect: () => unknown) {
		const report = (cause: unknown) =>
			console.error(new TandemServerError({ operation: "after", cause }))
		// Effects are consumer code; their failures cannot undo the commit.
		const result = errore.try(effect)
		if (result instanceof Error) return report(result)
		if (result instanceof Promise) void result.catch(report)
	}

	private async readLastMutationId(
		clientId: ClientId,
		operation: "push" | "pull",
	) {
		const metadata = (
			this.tupleDb as unknown as AsyncTupleDatabaseClient<TandemClientTuple>
		).subspace(["client"])
		const client = await metadata
			.get([clientId])
			.catch((cause) => new TandemServerError({ operation, cause }))
		if (client instanceof Error) return client
		return client?.lastMutationId ?? tag<MutationId>(0)
	}

	private async readPull(
		args: Parameters<RemoteApi<Schema>["pull"]>[0],
	): Promise<
		TandemServerError | Awaited<ReturnType<RemoteApi<Schema>["pull"]>>
	> {
		const { clientId, cookie, scanWindow } = args
		const client = this.getSyncClient(clientId)
		const serialized = errore.try(() => JSON.stringify(scanWindow))
		if (serialized instanceof Error)
			return {
				error: "invalid-request",
				message: "Scan window must be serializable",
			}
		const lastMutationId = await this.readLastMutationId(clientId, "pull")
		if (lastMutationId instanceof Error) return lastMutationId

		const shouldReset = cookie === undefined || cookie !== client.cookie
		const records = await executeScanWindowAsync<Schema, Relations>(
			this.recordDb,
			this.relations,
			scanWindow,
		).catch((cause) => new TandemServerError({ operation: "pull", cause }))
		if (records instanceof InvalidScanWindowError) {
			return { error: "invalid-request", message: records.message }
		}
		if (records instanceof Error) return records

		const currentRecords = new Map(
			records.map((record) => {
				const key = scanWindowRecordToKey(record)
				return [recordId(key), key]
			}),
		)
		const remove: PatchRemoveOp<Schema>[] = shouldReset
			? []
			: [...(client.syncedRecords ?? [])]
					.filter(([id]) => !currentRecords.has(id))
					.map(([, key]) => key)
		const nextCookie = tag<Cookie>(this.rng?.randomId() ?? crypto.randomUUID())
		client.syncedRecords = currentRecords
		client.cookie = nextCookie
		// Only a connected client has a view. A pull that runs after the last
		// connection closed must not record one for a later reconnect.
		// In-process callers can keep mutating the array they passed, so copy it.
		client.scanWindow = client.pokes.size
			? (JSON.parse(serialized) as ScanWindow<Schema>)
			: undefined
		client.liveRecordIds = new Set()
		// The pull returns every buffered change.
		client.buffer.clear()

		return {
			cookie: nextCookie,
			patch: { ...(shouldReset ? { reset: true } : {}), set: records, remove },
			lastMutationId,
			// The run queue orders pulls after every earlier commit.
			revision: this.revision,
		}
	}

	private get revision(): Revision {
		return { server: this.instanceId, commit: this.commitCount }
	}

	private async commitTransaction(
		transaction: TandemServerTransaction<Schema, Relations>,
		options: CommitOptions,
	): Promise<TandemServerError | undefined> {
		const writes = transaction.recordWrites()
		const previous = await Promise.all(
			writes.set.map(({ key }) =>
				this.recordDb.get(key as SchemaToTupleSchema<Schema>["key"]),
			),
		).catch(
			(cause) => new TandemServerError({ operation: options.operation, cause }),
		)
		if (previous instanceof Error) return previous
		// Removals carry the client's identity form, which only the old record has.
		const removed = await Promise.all(
			writes.remove.map(
				(key) =>
					this.recordDb.get(
						key as SchemaToTupleSchema<Schema>["key"],
					) as Promise<Schema[CollectionName<Schema>] | undefined>,
			),
		).catch(
			(cause) => new TandemServerError({ operation: options.operation, cause }),
		)
		if (removed instanceof Error) return removed
		this.committing = true
		const hasWrites = await transaction
			.commit()
			.finally(() => {
				this.committing = false
			})
			.catch(
				(cause) =>
					new TandemServerError({ operation: options.operation, cause }),
			)
		if (hasWrites instanceof Error) return hasWrites
		if (!hasWrites) return

		this.commitCount += 1
		// Compare the committed before-image with the final transaction write.
		const appended = new Map<
			string,
			DerivedAppend<Schema> & { after: Revision }
		>()
		for (const [index, { key, value }] of writes.set.entries()) {
			const fields = errore.try({
				try: () =>
					appendedFields(
						previous[index] as Record<string, unknown> | undefined,
						value as Record<string, unknown>,
					),
				catch: () => new Error("Append fields cannot be compared"),
			})
			if (!fields || fields instanceof Error) continue
			const valueCodec = this.schema.collections[key[1]].codec
			const suffixSupported = errore.try({
				try: () =>
					!valueCodec ||
					fields.every(({ field, text }) => {
						const encoded = errore.try({
							try: () => valueCodec.encode({ [field]: text }),
							catch: () => new Error("Append suffix cannot be encoded"),
						})
						if (
							encoded instanceof Error ||
							typeof (encoded as Record<string, unknown>)[field] !== "string"
						)
							return false
						const decoded = errore.try({
							try: () => valueCodec.decode(encoded),
							catch: () => new Error("Append suffix cannot be decoded"),
						})
						return (
							!(decoded instanceof Error) &&
							(decoded as Record<string, unknown>)[field] === text
						)
					}),
				catch: () => new Error("Append suffix cannot be represented"),
			})
			if (suffixSupported !== true) continue
			const append = {
				collection: key[1],
				id: (value as Schema[CollectionName<Schema>]).id,
				fields,
			} as DerivedAppend<Schema>
			const id = recordId(append)
			appended.set(id, {
				...append,
				after: {
					server: this.instanceId,
					commit: this.lastWrites.get(id) ?? this.forgottenWritesThrough,
				},
			})
		}
		const changes: CommitChanges<Schema> = {
			revision: this.revision,
			set: writes.set.map(({ key, value }) => ({
				collection: key[1],
				value,
			})) as PatchSetOp<Schema>[],
			remove: removed.flatMap((record, index) =>
				record === undefined
					? []
					: [{ collection: writes.remove[index]![1], id: record.id }],
			) as PatchRemoveOp<Schema>[],
			append: appended,
			pusher: options.operation === "push" ? options.clientId : undefined,
		}
		this.recordLastWrites([
			...writes.set.map(({ key }) => key),
			...writes.remove,
		])
		await this.emitLivePokes(changes)
	}

	/**
	 * Another process wrote storage, so any record may have changed since its
	 * last write here. Appends then wait for a pull read after this point.
	 */
	private forgetLastWrites() {
		this.commitCount += 1
		this.lastWrites.clear()
		this.forgottenWritesThrough = this.commitCount
	}

	/** Remembers this commit as the last write of each record it wrote. */
	private recordLastWrites(keys: readonly (readonly unknown[])[]) {
		for (const key of keys) {
			const id = JSON.stringify(key.slice(1))
			this.lastWrites.delete(id)
			this.lastWrites.set(id, this.commitCount)
		}
		for (const [id, commit] of this.lastWrites) {
			if (this.lastWrites.size <= trackedWrites) break
			this.lastWrites.delete(id)
			this.forgottenWritesThrough = commit
		}
	}

	/**
	 * Buffers the changed records inside each client's view, and pokes clients
	 * that must pull now.
	 */
	private async emitLivePokes(changes: CommitChanges<Schema>) {
		for (const [clientId, client] of this.syncClients) {
			if (!client.pokes.size) continue
			// Before its first pull the server does not know the client's view.
			if (!client.scanWindow) {
				this.pokeClient(client)
				continue
			}
			const buffered = await this.bufferLiveChanges(
				client,
				client.scanWindow,
				changes,
			)
			if (buffered instanceof Error) {
				// The client still pulls, so only the live update is lost.
				console.error(buffered)
				this.flushLivePayload(client)
				this.pokeClient(client)
				continue
			}
			// The pusher pulls its acknowledgement now, not when live payloads go
			// quiet. An offset shifts which records are in view when one before it
			// changes, even one the client never saw, so let the client pull.
			if (this.touchesOffsetWindow(client.scanWindow, changes)) {
				// Prefix rows are cached for local pagination, but page shifts
				// need a pull before detailed changes can be interpreted.
				client.buffer.clear()
				this.pokeClient(client)
				continue
			}
			if (clientId === changes.pusher) {
				this.flushLivePayload(client)
				this.pokeClient(client)
				continue
			}
			if (buffered) this.scheduleLivePayload(client)
		}
	}

	/** Merges a commit's changes inside the client's view into its next payload. */
	private async bufferLiveChanges(
		client: SyncClientState<Schema>,
		scanWindow: ScanWindow<Schema>,
		changes: CommitChanges<Schema>,
	): Promise<TandemServerError | InvalidScanWindowError | boolean> {
		const inView = await selectScanWindowRecordsAsync<Schema, Relations>(
			this.recordDb,
			this.relations,
			scanWindow,
			changes.set,
		).catch((cause) => new TandemServerError({ operation: "poke", cause }))
		if (inView instanceof Error) return inView

		// Only name records the client has, or will have from its next payload;
		// others must stay invisible.
		const sent = (id: string) =>
			client.syncedRecords?.has(id) || client.liveRecordIds.has(id)
		const known = (id: string) => sent(id) || client.buffer.carries(id)
		const inViewIds = new Set<string>()
		for (const { collection, value } of inView) {
			const id = recordId({ collection, id: value.id })
			inViewIds.add(id)
			const op = { collection, value } as PatchSetOp<Schema>
			const appended = changes.append.get(id)
			client.buffer.add(
				changes.revision,
				id,
				appended && known(id)
					? {
							type: "append",
							op,
							fields: appended.fields,
							after: appended.after,
						}
					: { type: "set", op },
			)
		}
		const leftView = changes.set
			.map(scanWindowRecordToKey)
			.filter((key) => !inViewIds.has(recordId(key)))
		const remove = [...changes.remove, ...leftView].filter((key) =>
			known(recordId(key)),
		)
		for (const op of remove) {
			const id = recordId(op)
			// A record the client never received leaves without a trace.
			if (sent(id))
				client.buffer.add(changes.revision, id, { type: "remove", op })
			else client.buffer.forget(id)
		}
		return inViewIds.size > 0 || remove.length > 0
	}

	/**
	 * Sends a client's buffered changes at once if it has had no payload this
	 * interval, and otherwise when the interval ends.
	 */
	private scheduleLivePayload(client: SyncClientState<Schema>) {
		if (client.throttled) return
		this.flushLivePayload(client)
		if (!this.livePokeTimer) return
		client.throttled = true
		const timer = this.livePokeTimer
		const endInterval = () => {
			if (this.closed) return
			if (client.buffer.isEmpty) {
				client.throttled = false
				return
			}
			this.flushLivePayload(client)
			void timer.waitForNextTick().then(endInterval)
		}
		void timer.waitForNextTick().then(endInterval)
	}

	private flushLivePayload(client: SyncClientState<Schema>) {
		const live = client.buffer.take()
		if (!live) return
		for (const id of live.removed) client.liveRecordIds.delete(id)
		for (const id of live.carried) client.liveRecordIds.add(id)
		this.pokeClient(client, live.payload)
	}

	private touchesOffsetWindow(
		scanWindow: ScanWindow<Schema>,
		changes: CommitChanges<Schema>,
	) {
		const collections = scanWindowOffsetCollections(scanWindow)
		return [...changes.set, ...changes.remove].some(({ collection }) =>
			collections.has(collection),
		)
	}

	private emitPokes() {
		for (const client of this.syncClients.values()) {
			this.flushLivePayload(client)
			this.pokeClient(client)
		}
	}

	private pokeClient(
		client: SyncClientState<Schema>,
		payload?: PokePayload<Schema>,
	) {
		for (const poke of client.pokes) {
			const result = errore.try(() => poke(payload))
			if (result instanceof Error) {
				console.error(
					new TandemServerError({ operation: "poke", cause: result }),
				)
			}
		}
	}
}
