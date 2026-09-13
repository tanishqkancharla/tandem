import {
	InMemoryTupleStorage,
	type ReadOnlyTupleDatabaseClientApi,
	subscribeQuery,
	TupleDatabase,
	TupleDatabaseClient,
	type TupleRootTransactionApi,
	type WriteOps,
} from "tuple-database"
import {
	type AnySchema,
	type AnyRelations,
	type RuntimeSchemaDefinition,
	type SchemaToTupleSchema,
} from "./schema/Schema"
import { type RelationalQuery, type RelationalQueryResult } from "./query/Query"
import { executeQuerySync } from "./query/executeQuery"
import {
	TandemClientStorage,
	type TandemClientStorageApi,
	WriteOpsApi,
} from "./storage/TandemClientStorage"
import { Transaction } from "./transaction/Transaction"
import type { LoggerApi } from "./utils/Logger"
import type { RngApi } from "./utils/randomId"
import { ThrottleQueue } from "./utils/ThrottleQueue"
import { Timer } from "./utils/Timer"

export type DatabaseArgs<
	Schema extends AnySchema,
	Relations extends AnyRelations<Schema>,
> = {
	schema?: RuntimeSchemaDefinition<Schema>
	relations?: Relations
	clientStorage?: TandemClientStorageApi<Schema>
	logger: LoggerApi
	rng: RngApi
}

export class Database<
	Schema extends AnySchema,
	Relations extends AnyRelations<Schema> = AnyRelations<Schema>,
> {
	private readonly tupleDb = new TupleDatabaseClient<
		SchemaToTupleSchema<Schema>
	>(new TupleDatabase(new InMemoryTupleStorage()))

	private readonly clientStorage?: TandemClientStorage<Schema>
	private readonly logger: LoggerApi
	private readonly rng: RngApi
	readonly schema?: RuntimeSchemaDefinition<Schema>
	readonly relations?: Relations
	private clientStorageWriteQueue?: ThrottleQueue
	readonly ready: Promise<void>

	constructor({
		logger,
		schema,
		relations,
		clientStorage,
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

		this.ready = this.clientStorage
			? this.loadFromStorage(this.clientStorage)
			: Promise.resolve()
	}

	async clear() {
		// Clear the in-memory tuple database
		const writeOps: WriteOps<SchemaToTupleSchema<Schema>> = {
			remove: this.tupleDb.scan({}).map(({ key }) => key),
		}

		if (writeOps.remove?.length) {
			this.tupleDb.commit(writeOps)
		}

		// Clear storage if available
		await this.clientStorage?.clear()
	}

	/**
	 * What if values in storage changes?
	 * What if storage too big to load all at once?
	 */
	private async loadFromStorage(storage: TandemClientStorage<Schema>) {
		this.logger.info({ message: "loading from storage" })
		const results = await storage.scan()
		this.tupleDb.commit({ set: results })

		let writeOpsQueue: WriteOps<SchemaToTupleSchema<Schema>> = {}

		const clientStorageWriteQueue = new ThrottleQueue(
			async () => {
				this.logger.info({ message: "committing to storage" })
				const copy = writeOpsQueue
				writeOpsQueue = {}
				try {
					await storage.commit(copy)
					this.logger.info({ message: "committed to storage" })
				} catch (error) {
					this.logger.error({ message: "error committing to storage", error })
					writeOpsQueue = copy
				}
			},
			120,
			new Timer(),
		)

		this.clientStorageWriteQueue = clientStorageWriteQueue

		this.tupleDb.subscribe({}, (writeOps) => {
			writeOpsQueue = WriteOpsApi.merge(writeOpsQueue, writeOps)
			void clientStorageWriteQueue.enqueue()
		})
	}

	/**
	 * Flush any pending writes to storage immediately.
	 */
	async flushClientStorage(): Promise<void> {
		await this.clientStorageWriteQueue?.flush()
	}

	makeTupleDbTransaction(): TupleRootTransactionApi<
		SchemaToTupleSchema<Schema>
	> {
		return this.tupleDb.transact(this.rng.randomId())
	}

	transact(): Transaction<Schema> {
		const tupleDbTx = this.tupleDb.transact(this.rng.randomId())
		return new Transaction(tupleDbTx)
	}

	commit(transaction: Transaction<Schema>) {
		transaction.tupleDbTx.commit()
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
		db: ReadOnlyTupleDatabaseClientApi<SchemaToTupleSchema<Schema>>,
		query: Query,
	): RelationalQueryResult<Schema, Relations, Query> {
		return executeQuerySync<Schema, Relations, Query>(db, this.relations, query)
	}
}
