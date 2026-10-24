import * as errore from "errore"
import {
	InMemoryTupleStorage,
	type ReadOnlyTupleDatabaseClientApi,
	subscribeQuery,
	TupleDatabase,
	TupleDatabaseClient,
	type WriteOps,
} from "tuple-database"
import {
	type AnySchema,
	type AnyRelations,
	type CollectionId,
	type CollectionName,
	collectionIdToTuple,
	type RuntimeSchemaDefinition,
	type SchemaToTupleSchema,
} from "./schema/Schema.js"
import {
	type RelationalQuery,
	type RelationalQueryResult,
} from "./query/Query.js"
import { executeQuerySync } from "./query/executeQuery.js"
import {
	TandemClientStorage,
	type TandemClientBase,
	type TandemClientStorageApi,
	type TandemClientTuple,
	WriteOpsApi,
} from "./clientStorage/TandemClientStorage.js"
import {
	type MutationId,
	type MutationOp,
	type SetMutationOp,
	type RemoveMutationOp,
	type TupleClientBase,
	type TupleClientOutbox,
	type TupleClientRecord,
	Transaction,
} from "./transaction/Transaction.js"
import type {
	ClientId,
	PokePayload,
	PullResponse,
	Revision,
} from "./sync/SyncEngine.js"
import type { LoggerApi } from "./utils/Logger.js"
import type { RngApi } from "./utils/randomId.js"
import { isEqual } from "./utils/objectUtils.js"
import { ThrottleQueue } from "./utils/ThrottleQueue.js"
import { Timer, type TimerApi } from "./utils/Timer.js"
import { tag, unreachable } from "./utils/typeUtils.js"

class ClientStorageError extends errore.createTaggedError({
	name: "ClientStorageError",
	message: "Client storage $operation failed",
}) {}

function mutationOpToRecordKey<Schema extends AnySchema>(
	op: MutationOp<Schema>,
): TupleClientRecord<Schema>["key"] {
	switch (op.type) {
		case "set":
			return [op.collection, ...collectionIdToTuple<CollectionId>(op.value.id)]
		case "remove":
		case "update":
			return [op.collection, ...collectionIdToTuple<CollectionId>(op.id)]
		default:
			return unreachable(op)
	}
}

function applyOp<Schema extends AnySchema>(
	transaction: Transaction<Schema>,
	op: MutationOp<Schema>,
): void {
	const key = mutationOpToRecordKey(op)
	switch (op.type) {
		case "set":
			transaction.records.set(key, op.value)
			return
		case "remove":
			transaction.records.remove(key)
			return
		case "update": {
			const current = transaction.records.get(key)
			if (current !== undefined) {
				transaction.records.set(key, { ...current, ...op.payload })
			}
			return
		}
		default:
			return unreachable(op)
	}
}

function recordKeyId(key: readonly unknown[]): string {
	return JSON.stringify(key)
}

/** A server value from a poke, shown until a pull reflects its revision. */
type LiveRecord<Schema extends AnySchema> = {
	key: TupleClientRecord<Schema>["key"]
	/** Undefined when the poke removed the record. */
	value: Schema[CollectionName<Schema>] | undefined
	revision: Revision
}

/** Whether `revision` is a later commit of the server that numbered `than`. */
function isLaterCommit(revision: Revision, than: Revision) {
	return revision.server === than.server && revision.commit > than.commit
}

/** Whether `than` is the same server at or after `revision`. */
function isCoveredBy(revision: Revision, than: Revision | undefined) {
	return (
		than !== undefined &&
		revision.server === than.server &&
		revision.commit <= than.commit
	)
}

function writeServerValue<Schema extends AnySchema>(
	transaction: Transaction<Schema>,
	key: TupleClientRecord<Schema>["key"],
	server: TandemClientBase<Schema[CollectionName<Schema>]>["server"],
) {
	switch (server.type) {
		case "set":
			transaction.records.set(key, server.value)
			return
		case "remove":
			transaction.records.remove(key)
			return
		default:
			unreachable(server)
	}
}

function liveServerValue<Schema extends AnySchema>(
	live: LiveRecord<Schema>,
): TandemClientBase<Schema[CollectionName<Schema>]>["server"] {
	return live.value === undefined
		? { type: "remove" }
		: { type: "set", value: live.value }
}

export type DatabaseArgs<
	Schema extends AnySchema,
	Relations extends AnyRelations<Schema>,
> = {
	schema?: RuntimeSchemaDefinition<Schema>
	relations?: Relations
	clientStorage?: TandemClientStorageApi<Schema>
	initialClientId?: ClientId
	clientStorageWriteInterval: number | TimerApi
	logger: LoggerApi
	rng: RngApi
}

export class Database<
	Schema extends AnySchema,
	Relations extends AnyRelations<Schema> = AnyRelations<Schema>,
> {
	// Root operations span every namespace; typed subspace views recover Schema below.
	private readonly tupleDb: TupleDatabaseClient<TandemClientTuple<AnySchema>>

	private readonly clientStorage?: TandemClientStorage<Schema>
	private readonly logger: LoggerApi
	private readonly rng: RngApi
	readonly schema?: RuntimeSchemaDefinition<Schema>
	readonly relations?: Relations
	private readonly clientStorageWriteQueue?: ThrottleQueue<void | ClientStorageError>
	private storageWrites: WriteOps<TandemClientTuple<AnySchema>> = {}
	private storageClearQueued = false
	// Live records are transient: they never enter the outbox, and hydration
	// rebuilds saved records from their bases, so restarts drop them.
	private readonly live = new Map<string, LiveRecord<Schema>>()
	private pulledRevision?: Revision
	private initialized = false
	readonly ready: Promise<void>

	get isReady() {
		return this.initialized
	}

	// tuple-database cannot reduce namespace filters over our generic mapped schema.
	// The prefix fixes the namespace, so only these views assert its Schema-specific values.
	private get records() {
		return this.tupleDb.subspace(["record"]) as unknown as TupleDatabaseClient<
			TupleClientRecord<Schema>
		>
	}

	private get bases() {
		return this.tupleDb.subspace(["base"]) as unknown as TupleDatabaseClient<
			TupleClientBase<Schema>
		>
	}

	get outbox() {
		return this.tupleDb.subspace(["outbox"]) as unknown as TupleDatabaseClient<
			TupleClientOutbox<Schema>
		>
	}

	get replica() {
		// Sync operations run only after hydration has restored or initialized this tuple.
		const replica = this.tupleDb.get(["replica"])
		if (!replica) throw new Error("Replica is not initialized")
		return replica
	}

	private initializeReplica(clientId: ClientId) {
		this.tupleDb.commit({
			set: [
				{
					key: ["replica"],
					value: { clientId, lastIssuedMutationId: tag<MutationId>(0) },
				},
			],
		})
	}

	constructor({
		logger,
		schema,
		relations,
		clientStorage,
		initialClientId,
		clientStorageWriteInterval,
		rng,
	}: DatabaseArgs<Schema, Relations>) {
		this.logger = logger
		this.schema = schema
		this.relations = relations
		this.clientStorage = clientStorage
			? new TandemClientStorage(clientStorage, (error) => {
					// TODO: clean up? What should we do when storage fails?
					this.logger.error({ message: "storage error", error })
				})
			: undefined

		this.rng = rng
		this.tupleDb = new TupleDatabaseClient(
			new TupleDatabase(new InMemoryTupleStorage(), { rng }),
		)

		const clientStorageWriteTimer =
			typeof clientStorageWriteInterval === "number"
				? new Timer({ interval: clientStorageWriteInterval })
				: clientStorageWriteInterval
		if (this.clientStorage) {
			this.clientStorageWriteQueue = new ThrottleQueue(
				() => this.persistStorageBatch(),
				clientStorageWriteTimer,
			)
		}
		const initialize = () => {
			// Hydration restores an existing checkpoint; do not enqueue it for saving again.
			if (this.clientStorage)
				this.tupleDb.subscribe({}, (writes) => {
					this.storageWrites = WriteOpsApi.merge(this.storageWrites, writes)
					void this.persistClientStorage()?.then(
						(result) => {
							if (result instanceof Error)
								this.logger.error({
									message: "error committing to storage",
									error: result,
								})
						},
						(error) =>
							this.logger.error({
								message: "error committing to storage",
								error,
							}),
					)
				})
			if (initialClientId && !this.tupleDb.get(["replica"]))
				this.initializeReplica(initialClientId)
			if (this.clientStorage) this.rebuildRestoredRecords()
			this.initialized = true
		}
		if (this.clientStorage) {
			this.ready = this.loadFromStorage(this.clientStorage).then((result) => {
				if (result instanceof Error) throw result
				initialize()
			})
		} else {
			initialize()
			this.ready = Promise.resolve()
		}
	}

	clear(clientId?: ClientId) {
		// Supersede queued old-session writes; an active batch finishes before the clear batch.
		this.storageWrites = {}
		this.storageClearQueued = true
		this.live.clear()
		this.pulledRevision = undefined
		const tx = this.tupleDb.transact(this.rng.randomId())
		for (const { key } of tx.scan({})) tx.remove(key)
		if (clientId)
			tx.set(["replica"], {
				clientId,
				lastIssuedMutationId: tag<MutationId>(0),
			})
		tx.commit()
		return this.flushClientStorage()
	}

	/**
	 * What if values in storage changes?
	 * What if storage too big to load all at once?
	 */
	private async loadFromStorage(storage: TandemClientStorage<Schema>) {
		this.logger.info({ message: "loading from storage" })
		const checkpoint = await storage
			.scan()
			.catch((cause) => new ClientStorageError({ operation: "scan", cause }))
		if (checkpoint instanceof Error) return checkpoint
		// Restore Schema-specific storage values into the namespace-wide root view.
		this.tupleDb.commit({ set: checkpoint as TandemClientTuple<AnySchema>[] })
	}

	private async persistStorageBatch() {
		const writes = this.storageWrites
		const clear = this.storageClearQueued
		this.storageWrites = {}
		this.storageClearQueued = false
		await this.ready
		const result = await (async () => {
			if (clear) {
				const cleared = await this.clientStorage!.clear().catch(
					(cause) => new ClientStorageError({ operation: "clear", cause }),
				)
				if (cleared instanceof Error) return cleared
			}
			if (!writes.set?.length && !writes.remove?.length) return
			// The root spans all namespaces; storage restores the configured schema at its boundary.
			return this.clientStorage!.commit(
				writes as WriteOps<TandemClientTuple<Schema>>,
			).catch((cause) => new ClientStorageError({ operation: "commit", cause }))
		})()
		if (result instanceof Error && !this.storageClearQueued) {
			this.storageWrites = WriteOpsApi.merge(writes, this.storageWrites)
			this.storageClearQueued = clear
		}
		return result
	}

	persistClientStorage() {
		if (
			!this.storageClearQueued &&
			!this.storageWrites.set?.length &&
			!this.storageWrites.remove?.length
		)
			return this.clientStorageWriteQueue?.flush()
		return this.clientStorageWriteQueue?.enqueue()
	}

	/**
	 * Flush any pending writes to storage immediately.
	 */
	async flushClientStorage() {
		await this.ready
		void this.persistClientStorage()
		return this.clientStorageWriteQueue?.flush()
	}

	transact(): Transaction<Schema> {
		return new Transaction<Schema>(this.tupleDb.transact(this.rng.randomId()))
	}

	commit(transaction: Transaction<Schema>) {
		transaction.tupleDbTx.commit()
	}

	commitMutation(transaction: Transaction<Schema>): void {
		const tx = transaction.tupleDbTx
		const replica = this.replica
		const id = tag<MutationId>(replica.lastIssuedMutationId + 1)
		for (const op of transaction.ops) {
			const recordKey = mutationOpToRecordKey(op)
			// Pending bookkeeping reads the current checkpoint, not the user's draft read set.
			const base = this.bases.get(recordKey)
			// The draft already contains optimistic edits; capture the committed record instead.
			const value = this.records.get(recordKey)
			transaction.bases.set(recordKey, {
				server:
					base?.server ??
					(value === undefined ? { type: "remove" } : { type: "set", value }),
				lastWrittenBy: id,
			})
		}
		transaction.outbox.set([id], [...transaction.ops])
		tx.set(["replica"], { ...replica, lastIssuedMutationId: id })
		tx.commit()
	}

	applyPull({
		patch,
		lastMutationId,
		cookie,
		revision,
	}: PullResponse<Schema>): void {
		const transaction = this.transact()
		const tx = transaction.tupleDbTx
		const { records, bases, outbox } = transaction
		if (patch.reset) {
			for (const { key } of records.scan()) records.remove(key)
			for (const { key, value } of bases.scan()) {
				bases.set(key, { ...value, server: { type: "remove" } })
			}
		}
		for (const op of patch.set ?? [])
			this.applyServerOp(transaction, { type: "set", ...op })
		for (const op of patch.remove ?? [])
			this.applyServerOp(transaction, { type: "remove", ...op })
		for (const { key } of outbox.scan({ lte: [lastMutationId] }))
			outbox.remove(key)
		// The pull reflects the server at its revision, so it replaces every live
		// record from that commit or earlier: updates, deletes, and records that
		// left the view alike. A newer live record stays over the rebuilt base.
		const remaining = new Map(
			[...this.live].filter(
				([, live]) =>
					revision !== undefined && isLaterCommit(live.revision, revision),
			),
		)
		const trackedBases = bases.scan()
		for (const { key, value } of trackedBases)
			writeServerValue(transaction, key, value.server)
		for (const live of remaining.values())
			writeServerValue(transaction, live.key, liveServerValue(live))
		// Preserve mutation and operation order; write() reorders removes before sets.
		for (const { value: ops } of outbox.scan()) {
			for (const op of ops) applyOp(transaction, op)
		}
		// Restoration still needs acknowledged bases, especially for records outside
		// the scan window. A live record keeps its base to rebuild under it.
		for (const { key, value } of trackedBases) {
			if (
				value.lastWrittenBy <= lastMutationId &&
				!remaining.has(recordKeyId(key))
			)
				bases.remove(key)
		}
		tx.set(["replica"], { ...this.replica, cookie })
		tx.commit()
		this.live.clear()
		for (const [id, live] of remaining) this.live.set(id, live)
		this.pulledRevision = revision
	}

	/**
	 * Show records a poke carried before the pull that confirms them. A live
	 * record replaces the record's confirmed value; pending writes replay on top.
	 */
	applyPoke({ revision, set = [], remove = [] }: PokePayload<Schema>): void {
		// The latest pull already reflects this commit.
		if (isCoveredBy(revision, this.pulledRevision)) return
		const transaction = this.transact()
		const { records, bases, outbox } = transaction
		const applied = new Map<string, LiveRecord<Schema>>()
		const ops = [
			...set.map((op) => ({ type: "set" as const, ...op })),
			...remove.map((op) => ({ type: "remove" as const, ...op })),
		]
		for (const op of ops) {
			const key = mutationOpToRecordKey(op)
			const id = recordKeyId(key)
			if (isCoveredBy(revision, this.live.get(id)?.revision)) continue
			// The base keeps the confirmed value, so a pull can rebuild under it.
			if (!bases.get(key)) {
				const confirmed = records.get(key)
				bases.set(key, {
					server:
						confirmed === undefined
							? { type: "remove" }
							: { type: "set", value: confirmed },
					lastWrittenBy: tag<MutationId>(0),
				})
			}
			const live: LiveRecord<Schema> = {
				key,
				value: op.type === "set" ? op.value : undefined,
				revision,
			}
			applied.set(id, live)
			writeServerValue(transaction, key, liveServerValue(live))
		}
		if (!applied.size) return transaction.cancel()
		for (const { value: pending } of outbox.scan()) {
			for (const op of pending) {
				if (applied.has(recordKeyId(mutationOpToRecordKey(op))))
					applyOp(transaction, op)
			}
		}
		transaction.tupleDbTx.commit()
		for (const [id, live] of applied) this.live.set(id, live)
	}

	/**
	 * Saved records can include live values, which are not server state. Rebuild
	 * every tracked record from its base and pending writes, and drop bases that
	 * no pending write needs. A checkpoint without live values is unchanged.
	 */
	private rebuildRestoredRecords() {
		const rebuild = this.transact()
		const { bases, outbox } = rebuild
		const trackedBases = bases.scan()
		for (const { key, value } of trackedBases)
			writeServerValue(rebuild, key, value.server)
		for (const { value: ops } of outbox.scan()) {
			for (const op of ops) applyOp(rebuild, op)
		}
		const rebuilt = trackedBases.map(({ key, value }) => ({
			key,
			value: rebuild.records.get(key),
			unneeded: !outbox.get([value.lastWrittenBy]),
		}))
		rebuild.cancel()

		const transaction = this.transact()
		let changed = false
		for (const { key, value, unneeded } of rebuilt) {
			if (unneeded) {
				transaction.bases.remove(key)
				changed = true
			}
			if (isEqual(value, this.records.get(key))) continue
			changed = true
			if (value === undefined) transaction.records.remove(key)
			else transaction.records.set(key, value)
		}
		if (!changed) return transaction.cancel()
		transaction.tupleDbTx.commit()
	}

	private applyServerOp(
		transaction: Transaction<Schema>,
		op: SetMutationOp<Schema> | RemoveMutationOp<Schema>,
	): void {
		const recordKey = mutationOpToRecordKey(op)
		const base = transaction.bases.get(recordKey)
		if (base) {
			const server: TandemClientBase<Schema[CollectionName<Schema>]>["server"] =
				(() => {
					switch (op.type) {
						case "set":
							return { type: "set", value: op.value }
						case "remove":
							return { type: "remove" }
						default:
							return unreachable(op)
					}
				})()
			transaction.bases.set(recordKey, {
				...base,
				server,
			})
		}
		applyOp(transaction, op)
	}

	subscribe<Query extends RelationalQuery<Schema, Relations>>(
		query: Query,
		callback: (result: RelationalQueryResult<Schema, Relations, Query>) => void,
	): {
		result: RelationalQueryResult<Schema, Relations, Query>
		destroy: () => void
	} {
		return subscribeQuery(
			this.tupleDb,
			(db) => this.executeQuery(db, query),
			callback,
		)
	}

	query<Query extends RelationalQuery<Schema, Relations>>(
		query: Query,
	): RelationalQueryResult<Schema, Relations, Query> {
		return this.executeQuery(this.tupleDb, query)
	}

	private executeQuery<Query extends RelationalQuery<Schema, Relations>>(
		db: ReadOnlyTupleDatabaseClientApi<TandemClientTuple<AnySchema>>,
		query: Query,
	): RelationalQueryResult<Schema, Relations, Query> {
		// Queries only read the record namespace; narrow the generic mapped tuple union here.
		return executeQuerySync<Schema, Relations, Query>(
			db as unknown as ReadOnlyTupleDatabaseClientApi<
				SchemaToTupleSchema<Schema>
			>,
			this.relations,
			query,
		)
	}
}
