import type {
	AnyMutators,
	AnySchema,
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
	MutatorCall,
	MutatorContext,
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
> = {
	schema: RuntimeSchemaDefinition<Schema>
	relations: Relations
	storage: TandemServerStorageApi<NoInfer<Schema>>
	rng?: RngApi
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
}

/** What a server mutator knows beyond a shared one. */
export type ServerMutatorContext = MutatorContext & {
	location: "server"
	clientId: ClientId
	mutationId: MutationId
	/**
	 * Runs `effect` once the mutation commits, after its pokes. A retried push
	 * skips the mutation, so the effect runs at most once. It is not awaited and
	 * does not survive a crash: write a record for work that must finish.
	 */
	after(effect: () => unknown): void
}

export type ServerMutator<
	Schema extends AnySchema,
	Relations extends AnyRelations<Schema>,
	Args = Json,
> = {
	args: MutatorArgs<Json, Args>
	run: (
		tx: TandemServerTransaction<Schema, Relations>,
		args: Args,
		ctx: ServerMutatorContext,
	) => unknown
}

export type ServerMutators<
	Schema extends AnySchema,
	Relations extends AnyRelations<Schema>,
> = {
	// Args is contravariant in run, so only any admits every concrete mutator.
	// oxlint-disable-next-line typescript/no-explicit-any
	[name: string]: ServerMutator<Schema, Relations, any>
}

export type TandemServerPushOptions<
	Schema extends AnySchema,
	Relations extends AnyRelations<Schema>,
> = {
	/** The mutators this push may run, usually built for the request's session. */
	mutators?: ServerMutators<Schema, Relations>
	/**
	 * Whether to apply mutations made of `set`, `update`, and `remove`
	 * operations. When false they are acknowledged with no effect and reported
	 * as rejected, like a failed mutator.
	 * @default true
	 */
	allowOps?: boolean
}

class MutatorRunError extends errore.createTaggedError({
	name: "MutatorRunError",
	message: "Mutator $mutator threw",
}) {}

function rejectionMessage(error: unknown) {
	return error instanceof Error ? error.message : String(error)
}

type CommitOptions =
	| { operation: "commit" }
	| { operation: "push"; clientId: ClientId }

/** Records one commit changed, read in the run queue right after it. */
type CommitChanges<Schema extends AnySchema> = {
	revision: Revision
	set: PatchSetOp<Schema>[]
	remove: PatchRemoveOp<Schema>[]
	/** The client whose push made the commit. It pulls to acknowledge it. */
	pusher?: ClientId
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

function tandemStorageToTupleDatabaseStorage<Schema extends AnySchema>(
	storage: TandemServerStorageApi<Schema>,
): AsyncTupleStorageApi {
	return {
		scan: (args) => storage.scan(args),
		commit: (writes) => storage.commit(writes as WriteOps<TandemTuple<Schema>>),
		close: () => storage.close(),
	}
}

export class TandemServer<
	Schema extends AnySchema,
	Relations extends AnyRelations<Schema>,
> implements RemoteApi<Schema> {
	private readonly relations: Relations
	private readonly subscriptions = new Set<() => void>()
	private readonly syncClients = new Map<ClientId, SyncClientState<Schema>>()
	private readonly tupleDb: AsyncTupleDatabaseClient<TandemTuple<Schema>>
	private readonly rng?: RngApi
	private readonly unsubscribeStorage?: () => void
	// Revisions are per instance, like cookies; a restart starts a new sequence.
	private readonly instanceId: string
	private commitCount = 0
	private closed = false
	// Tuple transactions batch writes but do not snapshot reads or serialize
	// asynchronous storage commits. Order sync reads and commits here.
	private queue: Promise<void> = Promise.resolve()

	constructor(args: TandemServerArgs<Schema, Relations>) {
		this.relations = args.relations
		this.rng = args.rng
		this.instanceId = args.rng?.randomId() ?? crypto.randomUUID()
		const database = new AsyncTupleDatabase(
			tandemStorageToTupleDatabaseStorage(args.storage),
			{ rng: args.rng },
		)
		this.tupleDb = new AsyncTupleDatabaseClient<TandemTuple<Schema>>(database)
		this.unsubscribeStorage = args.storage.subscribe?.(() => {
			if (this.closed) return
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

	/**
	 * Server mutators built from shared ones. An override replaces a shared
	 * mutator's server run, for authorization and `ctx.after` effects.
	 */
	serverMutators<Shared extends AnyMutators<Schema>>(
		shared: Shared,
		overrides: {
			[Name in keyof Shared]?: (
				tx: TandemServerTransaction<Schema, Relations>,
				args: MutatorArgsOf<Shared[Name]>,
				ctx: ServerMutatorContext,
			) => unknown
		} = {},
	): ServerMutators<Schema, Relations> {
		return Object.fromEntries(
			Object.entries(shared).map(([name, definition]) => [
				name,
				{ args: definition.args, run: overrides[name] ?? definition.run },
			]),
		)
	}

	push = (
		{ clientId, mutations }: Parameters<RemoteApi<Schema>["push"]>[0],
		options: TandemServerPushOptions<Schema, Relations> = {},
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
		}
		this.syncClients.set(clientId, created)
		return created
	}

	private async applyPush(
		clientId: ClientId,
		mutations: Mutation<Schema>[],
		{ mutators, allowOps = true }: TandemServerPushOptions<Schema, Relations>,
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
					mutators,
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
		mutators: ServerMutators<Schema, Relations> | undefined,
	): Promise<TandemServerError | MutationRejection | undefined> {
		const definition =
			mutators && Object.hasOwn(mutators, call.name)
				? mutators[call.name]
				: undefined
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
		const effects: (() => unknown)[] = []
		// The mutator is consumer code: whatever it throws is its verdict.
		const ran = await Promise.resolve()
			.then(() =>
				definition.run(transaction, args, {
					location: "server",
					clientId,
					mutationId,
					after: (effect) => {
						effects.push(effect)
					},
				}),
			)
			.catch(
				(cause: unknown) => new MutatorRunError({ mutator: call.name, cause }),
			)
		if (ran instanceof Error) {
			const cancelled = await transaction
				.cancel()
				.catch((cause) => new TandemServerError({ operation: "push", cause }))
			if (cancelled instanceof Error) return cancelled
			// Storage failures are not a refusal; leave the mutation pending.
			const storage = errore.findCause(ran, TandemServerError)
			if (storage) return storage
			return this.reject(clientId, mutationId, rejectionMessage(ran.cause))
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
		for (const effect of effects) this.runEffect(effect)
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
		const hasWrites = await transaction
			.commit()
			.catch(
				(cause) =>
					new TandemServerError({ operation: options.operation, cause }),
			)
		if (hasWrites instanceof Error) return hasWrites
		if (!hasWrites) return

		this.commitCount += 1
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
			pusher: options.operation === "push" ? options.clientId : undefined,
		}
		await this.emitLivePokes(changes)
	}

	/** Pokes each client with the changed records inside its view. */
	private async emitLivePokes(changes: CommitChanges<Schema>) {
		for (const [clientId, client] of this.syncClients) {
			if (!client.pokes.size) continue
			// Before its first pull the server does not know the client's view.
			if (!client.scanWindow) {
				this.pokeClient(client)
				continue
			}
			const payload = await this.readLivePayload(
				client,
				client.scanWindow,
				changes,
			)
			if (payload instanceof Error) {
				// The client still pulls, so only the live update is lost.
				console.error(payload)
				this.pokeClient(client)
				continue
			}
			if (payload) this.pokeClient(client, payload)
			// An offset shifts which records are in view when one before it changes,
			// even one the client never saw, so let the client pull.
			else if (
				clientId === changes.pusher ||
				this.touchesOffsetWindow(client.scanWindow, changes)
			)
				this.pokeClient(client)
		}
	}

	private async readLivePayload(
		client: SyncClientState<Schema>,
		scanWindow: ScanWindow<Schema>,
		changes: CommitChanges<Schema>,
	): Promise<
		TandemServerError | InvalidScanWindowError | PokePayload<Schema> | undefined
	> {
		const inView = await selectScanWindowRecordsAsync<Schema, Relations>(
			this.recordDb,
			this.relations,
			scanWindow,
			changes.set,
		).catch((cause) => new TandemServerError({ operation: "poke", cause }))
		if (inView instanceof Error) return inView

		const set = inView.map(({ collection, value }) => ({ collection, value }))
		const setIds = new Set(set.map((op) => recordId(scanWindowRecordToKey(op))))
		const leftView = changes.set
			.map(scanWindowRecordToKey)
			.filter((key) => !setIds.has(recordId(key)))
		// Only name records the client already has; others must stay invisible.
		const known = (key: SyncedRecordKey<Schema>) =>
			client.syncedRecords?.has(recordId(key)) ||
			client.liveRecordIds.has(recordId(key))
		const remove = [...changes.remove, ...leftView].filter(known)
		if (!set.length && !remove.length) return

		for (const key of remove) client.liveRecordIds.delete(recordId(key))
		for (const id of setIds) client.liveRecordIds.add(id)
		return {
			revision: changes.revision,
			...(set.length ? { set } : {}),
			...(remove.length ? { remove } : {}),
		} as PokePayload<Schema>
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
		for (const client of this.syncClients.values()) this.pokeClient(client)
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
