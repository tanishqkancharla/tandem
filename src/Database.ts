import {
	InMemoryTupleStorage,
	type ReadOnlyTupleDatabaseClientApi,
	subscribeQuery,
	TupleDatabase,
	TupleDatabaseClient,
	type TupleRootTransactionApi,
	type WriteOps,
} from "tuple-database"
import { QueryBuilder, QueryResults } from "./query/Query"
import { Storage } from "./storage/Storage"
import { Transaction } from "./transaction/Transaction"
import {
	AnySchema,
	CollectionName,
	RngApi,
	StorageApi,
	WriteOpsApi,
} from "./types"
import { LoggerApi } from "./utils/Logger"
import { isArray, isEqual, pick, sortBy } from "./utils/objectUtils"
import { ThrottleQueue } from "./utils/ThrottleQueue"
import { unreachable } from "./utils/typeUtils"

type DatabaseArgs = {
	storage?: StorageApi
	logger: LoggerApi
	rng: RngApi
}

export class Database<Schema extends AnySchema> {
	private readonly tupleDb: TupleDatabaseClient = new TupleDatabaseClient(
		new TupleDatabase(new InMemoryTupleStorage()),
	)

	private readonly storage?: Storage
	private readonly logger: LoggerApi
	private readonly rng: RngApi
	readonly ready: Promise<void>

	constructor({ logger, storage: storageAdapter, rng }: DatabaseArgs) {
		this.logger = logger
		this.storage = storageAdapter
			? new Storage(storageAdapter, (error) => {
					// TODO: clean up? What should we do when storage fails?
					this.logger.error("Storage error", error)
				})
			: undefined

		this.rng = rng

		this.ready = this.storage
			? this.loadFromStorage(this.storage)
			: Promise.resolve()
	}

	async clear() {
		// Clear the in-memory tuple database
		const writeOps = this.tupleDb.scan({}).reduce((ops, { key }) => {
			ops.remove = ops.remove || []
			ops.remove.push(key)
			return ops
		}, {} as WriteOps)

		if (writeOps.remove?.length) {
			this.tupleDb.commit(writeOps)
		}

		// Clear storage if available
		await this.storage?.clear()
	}

	/**
	 * What if values in storage changes?
	 * What if storage too big to load all at once?
	 */
	private async loadFromStorage(storage: Storage) {
		this.logger.info("Loading from storage")
		const results = await storage.scan()
		this.tupleDb.commit({ set: results })

		let writeOpsQueue: WriteOps = {}

		const storageWriteQueue = new ThrottleQueue(
			async () => {
				this.logger.info("Committing to storage...")
				const copy = writeOpsQueue
				writeOpsQueue = {}
				try {
					await storage.commit(copy)
					this.logger.info("Committed to storage")
				} catch (error) {
					this.logger.error("Error committing to storage", error)
					writeOpsQueue = copy
				}
			},
			(error) => {
				// TODO: fatal error
				this.logger.error("Error committing to storage", error)
			},
			120,
		)

		this.tupleDb.subscribe({}, (writeOps) => {
			writeOpsQueue = WriteOpsApi.merge(writeOpsQueue, writeOps)
			storageWriteQueue.enqueue()
		})
	}

	makeTupleDbTransaction(): TupleRootTransactionApi {
		return this.tupleDb.transact(this.rng.randomId())
	}

	transact(): Transaction<Schema> {
		const tupleDbTx = this.tupleDb.transact(this.rng.randomId())
		return new Transaction(tupleDbTx)
	}

	commit(transaction: Transaction<Schema>) {
		transaction.tupleDbTx.commit()
	}

	subscribe<
		Collection extends CollectionName<Schema>,
		Query extends QueryBuilder<Schema, Collection>,
	>(
		query: Query,
		callback: (result: QueryResults<Query>) => void,
	): { result: QueryResults<Query>; destroy: () => void } {
		return subscribeQuery(
			this.tupleDb,
			(db) => Database.runQuery(query, db),
			callback,
		)
	}

	run<
		Collection extends CollectionName<Schema>,
		Query extends QueryBuilder<Schema, Collection>,
	>(query: Query): QueryResults<Query> {
		return Database.runQuery(query, this.tupleDb)
	}

	private static runQuery<Query extends QueryBuilder<any, any>>(
		query: Query,
		tupleDb: ReadOnlyTupleDatabaseClientApi,
	): QueryResults<Query> {
		const { collection, limit, order, select, where } = query.build()

		let results = tupleDb
			.scan({
				gte: ["record", collection, null],
				lte: ["record", collection, true],
			})
			.map(({ value }) => value) as any[]

		if (where) {
			results = results.filter((value) => {
				return where.every(([attribute, operator, valueToTestAgainst]) => {
					const fieldValue = value[attribute]
					switch (operator) {
						case "=":
							return isEqual(fieldValue, valueToTestAgainst)
						case ">":
							return fieldValue > valueToTestAgainst
						case "<":
							return fieldValue < valueToTestAgainst
						case ">=":
							return fieldValue >= valueToTestAgainst
						case "<=":
							return fieldValue <= valueToTestAgainst
						default:
							unreachable(operator)
					}
				})
			})
		}

		if (order) {
			results = sortBy(
				results,
				...order.map(
					([attribute, direction]) =>
						[(item: any) => item[attribute], direction] as const,
				),
			)
		}

		if (isArray(select)) {
			results = results.map((value) => pick(value, select))
		}

		if (limit) {
			results = results.slice(0, limit)
		}

		return results as QueryResults<Query>
	}
}
