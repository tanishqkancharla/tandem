import {
	type AsyncTupleStorageApi,
	InMemoryTupleStorage,
	type ReadOnlyTupleDatabaseClientApi,
	subscribeQuery,
	TupleDatabase,
	TupleDatabaseClient,
	type TupleRootTransactionApi,
	type WriteOps,
} from "tuple-database"
import { LoggerApi } from "./Logger"
import { QueryBuilder, QueryResults } from "./Query"
import { Storage } from "./Storage"
import { ThrottleQueue } from "./ThrottleQueue"
import {
	AnySchema,
	CollectionName,
	InvertibleMutationOp,
	SchemaToTupleSchema,
	WriteOpsApi,
} from "./types"
import { isArray, isEqual, pick, sortBy } from "./utils/objectUtils"
import { unreachable } from "./utils/typeUtils"

type DatabaseArgs = {
	storage?: AsyncTupleStorageApi
	logger: LoggerApi
}

export class Database<Schema extends AnySchema> {
	private readonly tupleDb: TupleDatabaseClient = new TupleDatabaseClient(
		new TupleDatabase(new InMemoryTupleStorage()),
	)

	private readonly storage?: Storage
	private readonly logger: LoggerApi
	readonly ready: Promise<void>

	constructor({ logger, storage: storageAdapter }: DatabaseArgs) {
		this.logger = logger
		this.storage = storageAdapter
			? new Storage(storageAdapter, (error) => {
					// TODO: clean up? What should we do when storage fails?
					console.error("Storage error", error)
				})
			: undefined

		this.ready = this.storage
			? this.loadFromStorage(this.storage)
			: Promise.resolve()
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
				try {
					writeOpsQueue = {}
					await storage.commit(copy)
					this.logger.info("Committed to storage")
				} catch (error) {
					this.logger.error("Error committing to storage", error)
					writeOpsQueue = copy
				}
			},
			(error) => {
				// TODO: fatal error
				console.error("Error committing to storage", error)
			},
			120,
		)

		this.tupleDb.subscribe({}, (writeOps) => {
			writeOpsQueue = WriteOpsApi.merge(writeOpsQueue, writeOps)
			storageWriteQueue.enqueue()
		})
	}

	makeTupleDbTransaction(): TupleRootTransactionApi {
		return this.tupleDb.transact()
	}

	transact(): Transaction<Schema> {
		const tupleDbTx = this.tupleDb.transact()
		return new Transaction(tupleDbTx)
	}

	commit(transaction: Transaction<Schema>) {
		transaction.tupleDbTx.commit()
	}

	subscribe<
		Collection extends CollectionName<Schema>,
		Query extends QueryBuilder<Schema, Schema[Collection]>,
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
		Query extends QueryBuilder<Schema, Schema[Collection]>,
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

export class Transaction<Schema extends AnySchema> {
	/**
	 * @internal
	 */
	readonly ops: InvertibleMutationOp<Schema>[] = []

	constructor(
		/**
		 * @internal
		 */
		readonly tupleDbTx: TupleRootTransactionApi,
	) {}

	list<Collection extends CollectionName<Schema>>(
		collection: Collection,
	): Readonly<Schema[Collection]>[] {
		const results = this.tupleDbTx.scan({
			gte: ["record", collection, null],
			lte: ["record", collection, true],
		})

		return results.map((result) => result.value)
	}

	get<Collection extends CollectionName<Schema>>(
		collection: Collection,
		id: Schema[Collection]["id"],
	): Readonly<Schema[Collection]> | undefined {
		const tupleSchemaKey: SchemaToTupleSchema<Schema>["key"] = [
			"record",
			collection,
			id,
		]

		const result = this.tupleDbTx.scan({
			gte: tupleSchemaKey,
			lte: tupleSchemaKey,
		})

		if (result.length === 0) {
			return undefined
		}

		return result[0].value
	}

	set<Collection extends CollectionName<Schema>>(
		collection: Collection,
		record: Schema[Collection],
	): Transaction<Schema> {
		const tupleSchema: SchemaToTupleSchema<Schema> = {
			key: ["record", collection, record.id],
			value: record,
		}

		const prevValueResult = this.tupleDbTx.scan({
			gte: tupleSchema.key,
			lte: tupleSchema.key,
		})

		this.tupleDbTx.set<any>(tupleSchema.key, tupleSchema.value)

		const setOp: InvertibleMutationOp<Schema> = {
			type: "set",
			collection,
			value: tupleSchema.value,
		}

		if (prevValueResult.length > 0) {
			setOp.prevValue = prevValueResult[0].value
		}

		console.log({ setOp })

		this.ops.push(setOp)

		return this
	}

	remove<Collection extends CollectionName<Schema>>(
		collection: Collection,
		id: Schema[Collection]["id"],
	): Transaction<Schema> {
		const tupleSchemaKey: SchemaToTupleSchema<Schema>["key"] = [
			"record",
			collection,
			id,
		]

		const values = this.tupleDbTx.scan({
			gte: tupleSchemaKey,
			lte: tupleSchemaKey,
		})

		this.tupleDbTx.remove(tupleSchemaKey)

		if (values.length) {
			this.ops.push({
				type: "remove",
				collection,
				id,
				value: values[0].value,
			})
		}

		return this
	}

	cancel() {
		this.tupleDbTx.cancel()
	}
}
