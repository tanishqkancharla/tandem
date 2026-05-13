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
	FieldWhereOperators,
	RngApi,
	RelationalQueryOptions,
	RelationalQueryResult,
	RuntimeRelationsDefinition,
	RuntimeSchemaDefinition,
	StorageApi,
	WriteOpsApi,
} from "@tandem/types"
import { LoggerApi } from "./utils/Logger"
import { isArray, isEqual, pick, sortBy } from "./utils/objectUtils"
import { ThrottleQueue } from "./utils/ThrottleQueue"
import { Timer } from "./utils/Timer"
import { unreachable } from "./utils/typeUtils"

type DatabaseArgs<
	Schema extends AnySchema,
	Relations extends RuntimeRelationsDefinition<Schema>,
> = {
	schema?: RuntimeSchemaDefinition<Schema>
	relations?: Relations
	storage?: StorageApi
	logger: LoggerApi
	rng: RngApi
}

export class Database<
	Schema extends AnySchema,
	Relations extends RuntimeRelationsDefinition<Schema> = RuntimeRelationsDefinition<Schema>,
> {
	private readonly tupleDb: TupleDatabaseClient = new TupleDatabaseClient(
		new TupleDatabase(new InMemoryTupleStorage()),
	)

	private readonly storage?: Storage
	private readonly logger: LoggerApi
	private readonly rng: RngApi
	readonly schema?: RuntimeSchemaDefinition<Schema>
	readonly relations?: Relations
	private storageWriteQueue?: ThrottleQueue
	readonly ready: Promise<void>

	constructor({
		logger,
		schema,
		relations,
		storage: storageAdapter,
		rng,
	}: DatabaseArgs<Schema, Relations>) {
		this.logger = logger
		this.schema = schema
		this.relations = relations
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
			120,
			new Timer(),
		)

		this.storageWriteQueue = storageWriteQueue

		this.tupleDb.subscribe({}, (writeOps) => {
			writeOpsQueue = WriteOpsApi.merge(writeOpsQueue, writeOps)
			void storageWriteQueue.enqueue()
		})
	}

	/**
	 * Flush any pending writes to storage immediately.
	 */
	async flushStorage(): Promise<void> {
		await this.storageWriteQueue?.flush()
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
	>(query: Query): QueryResults<Query>
	run<
		Collection extends CollectionName<Schema>,
		Options extends RelationalQueryOptions<Schema, Relations, Collection>,
	>(
		collection: Collection,
		options?: Options,
	): RelationalQueryResult<Schema, Relations, Collection, Options>
	run<
		Collection extends CollectionName<Schema>,
		Query extends QueryBuilder<Schema, Collection>,
		Options extends RelationalQueryOptions<Schema, Relations, Collection>,
	>(
		queryOrCollection: Query | Collection,
		options?: Options,
	): QueryResults<Query> | RelationalQueryResult<Schema, Relations, Collection, Options> {
		if (typeof queryOrCollection === "string") {
			return this.runRelationalQuery(queryOrCollection, options ?? ({} as Options))
		}

		const query = queryOrCollection
		return Database.runQuery(query, this.tupleDb)
	}

	private runRelationalQuery<
		Collection extends CollectionName<Schema>,
		Options extends RelationalQueryOptions<Schema, Relations, Collection>,
	>(
		collection: Collection,
		options: Options,
		extraFilter?: (record: Schema[Collection]) => boolean,
	): RelationalQueryResult<Schema, Relations, Collection, Options> {
		const rows = this.getRelationalRows(collection, options, extraFilter)
		return rows.map((row) =>
			this.expandRelationalRow(collection, row, options),
		) as RelationalQueryResult<Schema, Relations, Collection, Options>
	}

	private getRelationalRows<Collection extends CollectionName<Schema>>(
		collection: Collection,
		options: RelationalQueryOptions<Schema, Relations, Collection>,
		extraFilter?: (record: Schema[Collection]) => boolean,
	): Schema[Collection][] {
		let results = this.tupleDb
			.scan({
				gte: ["record", collection, null],
				lte: ["record", collection, true],
			})
			.map(({ value }) => value) as Schema[Collection][]

		if (extraFilter) {
			results = results.filter(extraFilter)
		}

		if (options.where) {
			results = results.filter((record) =>
				Object.entries(options.where ?? {}).every(([field, condition]) =>
					this.matchesRelationalWhere(record, field, condition),
				),
			)
		}

		if (options.orderBy) {
			results = sortBy(
				results,
				...Object.entries(options.orderBy).flatMap(([field, direction]) =>
					direction
						? [[(item: any) => item[field], direction] as const]
						: [],
				),
			)
		}

		if (options.offset !== undefined) {
			results = results.slice(options.offset)
		}

		if (options.limit !== undefined) {
			results = results.slice(0, options.limit)
		}

		return results
	}

	private matchesRelationalWhere(
		record: Record<string, any>,
		field: string,
		condition: unknown,
	): boolean {
		const fieldValue = record[field]

		if (
			typeof condition === "object" &&
			condition !== null &&
			!Array.isArray(condition)
		) {
			return Object.entries(condition as FieldWhereOperators<unknown>).every(
				([operator, value]) =>
					this.compareRelationalValue(fieldValue, operator, value),
			)
		}

		return isEqual(fieldValue, condition)
	}

	private compareRelationalValue(
		fieldValue: any,
		operator: string,
		comparisonValue: any,
	): boolean {
		switch (operator) {
			case "eq":
				return isEqual(fieldValue, comparisonValue)
			case "gt":
				return fieldValue > comparisonValue
			case "lt":
				return fieldValue < comparisonValue
			case "gte":
				return fieldValue >= comparisonValue
			case "lte":
				return fieldValue <= comparisonValue
			default:
				throw new Error(`Unknown where operator "${operator}"`)
		}
	}

	private expandRelationalRow<Collection extends CollectionName<Schema>>(
		collection: Collection,
		row: Schema[Collection],
		options: RelationalQueryOptions<Schema, Relations, Collection>,
	): Record<string, any> {
		const result: Record<string, any> = options.select
			? pick(row, Object.keys(options.select))
			: { ...row }

		if (!options.with) return result

		if (!this.relations) {
			throw new Error("Cannot execute relational query includes without relations")
		}

		for (const [relationName, includeOptions] of Object.entries(options.with)) {
			const relation = this.relations[collection]?.[relationName]
			if (!relation) {
				throw new Error(`Unknown relation "${collection}.${relationName}"`)
			}

			const targetCollection = relation.targetCollection
			const nestedOptions = includeOptions === true ? {} : (includeOptions as any)

			if (relation.type === "many-to-one") {
				const joinValue = row[relation.from]
				result[relationName] =
					this.runRelationalQuery(
						targetCollection,
						nestedOptions,
						(target) => target[relation.to] === joinValue,
					)[0] ?? null
			} else {
				const joinValue = row[relation.from]
				result[relationName] = this.runRelationalQuery(
					targetCollection,
					nestedOptions,
					(target) => target[relation.to] === joinValue,
				)
			}
		}

		return result
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
					const comparisonValue = valueToTestAgainst as any
					switch (operator) {
						case "=":
							return isEqual(fieldValue, comparisonValue)
						case ">":
							return fieldValue > comparisonValue
						case "<":
							return fieldValue < comparisonValue
						case ">=":
							return fieldValue >= comparisonValue
						case "<=":
							return fieldValue <= comparisonValue
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
