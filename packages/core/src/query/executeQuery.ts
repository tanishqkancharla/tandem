import type {
	ReadOnlyAsyncTupleDatabaseClientApi,
	ReadOnlyTupleDatabaseClientApi,
} from "tuple-database"
import type {
	AnyCollectionSchema,
	AnySchema,
	CollectionName,
	RuntimeRelationsDefinition,
} from "../schema/Schema"
import { isEqual, pick, sortBy } from "../utils/objectUtils"
import type {
	FieldWhereOperators,
	RelationalQuery,
	RelationalQueryResult,
} from "./Query"

type RuntimeRecord = Record<string, unknown>

type RecordTuple = {
	key: ["record", collection: string, id: string | number]
	value: AnyCollectionSchema
}

type TupleSchemaToSchema<TupleSchema extends RecordTuple> = {
	[Collection in TupleSchema["key"][1]]: Extract<
		TupleSchema,
		{ key: ["record", Collection, string | number] }
	>["value"]
}

type RuntimeQueryOptions = {
	readonly select?: Readonly<Record<string, true | undefined>>
	readonly where?: Readonly<Record<string, unknown>>
	readonly with?: Readonly<Record<string, true | RuntimeQueryOptions>>
	readonly orderBy?: Readonly<Record<string, "asc" | "desc" | undefined>>
	readonly limit?: number
	readonly offset?: number
}

type RuntimeQuery = RuntimeQueryOptions & {
	readonly collection: string
}

type RuntimeRelation = {
	readonly type: "many-to-one" | "one-to-many"
	readonly targetCollection: string
	readonly from: string
	readonly to: string
}

type RuntimeRelations = Readonly<
	Record<
		string,
		Readonly<Record<string, RuntimeRelation | undefined>> | undefined
	>
>

type RecordsByCollection = ReadonlyMap<string, readonly RuntimeRecord[]>

function getRuntimeRelations<
	Schema extends AnySchema,
	Relations extends RuntimeRelationsDefinition<Schema>,
>(relations: Relations | undefined): RuntimeRelations | undefined {
	return relations as unknown as RuntimeRelations | undefined
}

function collectQueryCollections(
	collection: string,
	options: RuntimeQueryOptions,
	relations: RuntimeRelations | undefined,
	collections: Set<string>,
) {
	collections.add(collection)
	if (!options.with) return

	if (!relations) {
		throw new Error(
			"Cannot execute relational query includes without relations",
		)
	}

	for (const [relationName, includeOptions] of Object.entries(options.with)) {
		const relation = relations[collection]?.[relationName]
		if (!relation) {
			throw new Error(`Unknown relation "${collection}.${relationName}"`)
		}

		collectQueryCollections(
			relation.targetCollection,
			includeOptions === true ? {} : includeOptions,
			relations,
			collections,
		)
	}
}

function getQueryCollections(
	query: RuntimeQuery,
	relations: RuntimeRelations | undefined,
) {
	const collections = new Set<string>()
	collectQueryCollections(query.collection, query, relations, collections)
	return collections
}

function scanCollectionSync<TupleSchema extends RecordTuple>(
	db: ReadOnlyTupleDatabaseClientApi<TupleSchema>,
	collection: CollectionName<TupleSchemaToSchema<TupleSchema>>,
): RuntimeRecord[] {
	const runtimeDb = db as ReadOnlyTupleDatabaseClientApi
	return runtimeDb
		.scan({ prefix: ["record", collection] })
		.map(({ value }) => value as RuntimeRecord)
}

async function scanCollectionAsync<TupleSchema extends RecordTuple>(
	db: ReadOnlyAsyncTupleDatabaseClientApi<TupleSchema>,
	collection: CollectionName<TupleSchemaToSchema<TupleSchema>>,
): Promise<RuntimeRecord[]> {
	const runtimeDb = db as ReadOnlyAsyncTupleDatabaseClientApi
	const tuples = await runtimeDb.scan({ prefix: ["record", collection] })
	return tuples.map(({ value }) => value as RuntimeRecord)
}

function loadRecordsSync<TupleSchema extends RecordTuple>(
	db: ReadOnlyTupleDatabaseClientApi<TupleSchema>,
	collections: ReadonlySet<string>,
) {
	return new Map(
		Array.from(collections, (collection) => [
			collection,
			scanCollectionSync(
				db,
				collection as CollectionName<TupleSchemaToSchema<TupleSchema>>,
			),
		]),
	)
}

async function loadRecordsAsync<TupleSchema extends RecordTuple>(
	db: ReadOnlyAsyncTupleDatabaseClientApi<TupleSchema>,
	collections: ReadonlySet<string>,
) {
	return new Map(
		await Promise.all(
			Array.from(
				collections,
				async (collection) =>
					[
						collection,
						await scanCollectionAsync(
							db,
							collection as CollectionName<TupleSchemaToSchema<TupleSchema>>,
						),
					] as const,
			),
		),
	)
}

function compareOrderedValues<Value extends string | number>(
	left: Value,
	right: Value,
) {
	if (left > right) return 1
	if (left < right) return -1
	return 0
}

function compareRelationalValue(
	fieldValue: unknown,
	operator: string,
	comparisonValue: unknown,
) {
	if (operator === "eq") return isEqual(fieldValue, comparisonValue)
	if (!["gt", "lt", "gte", "lte"].includes(operator)) {
		throw new Error(`Unknown where operator "${operator}"`)
	}

	const comparison = compareOrderedValues(
		fieldValue as string | number,
		comparisonValue as string | number,
	)
	if (operator === "gt") return comparison > 0
	if (operator === "lt") return comparison < 0
	if (operator === "gte") return comparison >= 0
	return comparison <= 0
}

function matchesRelationalWhere(
	record: RuntimeRecord,
	field: string,
	condition: unknown,
) {
	const fieldValue = record[field]

	if (
		typeof condition === "object" &&
		condition !== null &&
		!Array.isArray(condition)
	) {
		return Object.entries(condition as FieldWhereOperators<unknown>).every(
			([operator, value]) =>
				compareRelationalValue(fieldValue, operator, value),
		)
	}

	return isEqual(fieldValue, condition)
}

function getRelationalRows(
	collection: string,
	options: RuntimeQueryOptions,
	recordsByCollection: RecordsByCollection,
	extraFilter?: (record: RuntimeRecord) => boolean,
) {
	const collectionRecords = recordsByCollection.get(collection) ?? []
	const relationFiltered = extraFilter
		? collectionRecords.filter(extraFilter)
		: [...collectionRecords]
	const whereFiltered = options.where
		? relationFiltered.filter((record) =>
				Object.entries(options.where ?? {}).every(([field, condition]) =>
					matchesRelationalWhere(record, field, condition),
				),
			)
		: relationFiltered
	const ordered = options.orderBy
		? sortBy(
				whereFiltered,
				...Object.entries(options.orderBy).flatMap(([field, direction]) =>
					direction
						? [
								[
									(item: RuntimeRecord) => item[field] as string | number,
									direction,
								] as const,
							]
						: [],
				),
			)
		: whereFiltered
	const offset =
		options.offset === undefined ? ordered : ordered.slice(options.offset)

	return options.limit === undefined ? offset : offset.slice(0, options.limit)
}

function executeLoadedQuery(
	collection: string,
	options: RuntimeQueryOptions,
	relations: RuntimeRelations | undefined,
	recordsByCollection: RecordsByCollection,
	extraFilter?: (record: RuntimeRecord) => boolean,
): RuntimeRecord[] {
	const rows = getRelationalRows(
		collection,
		options,
		recordsByCollection,
		extraFilter,
	)

	return rows.map((row) => {
		const result: RuntimeRecord = options.select
			? pick(row, Object.keys(options.select))
			: { ...row }
		if (!options.with) return result

		if (!relations) {
			throw new Error(
				"Cannot execute relational query includes without relations",
			)
		}

		for (const [relationName, includeOptions] of Object.entries(options.with)) {
			const relation = relations[collection]?.[relationName]
			if (!relation) {
				throw new Error(`Unknown relation "${collection}.${relationName}"`)
			}

			const nestedOptions = includeOptions === true ? {} : includeOptions
			const joinValue = row[relation.from]
			const related = executeLoadedQuery(
				relation.targetCollection,
				nestedOptions,
				relations,
				recordsByCollection,
				(target) => target[relation.to] === joinValue,
			)

			result[relationName] =
				relation.type === "many-to-one" ? (related[0] ?? null) : related
		}

		return result
	})
}

export function executeQuerySync<
	TupleSchema extends RecordTuple,
	Relations extends RuntimeRelationsDefinition<
		TupleSchemaToSchema<TupleSchema>
	>,
	Query extends RelationalQuery<TupleSchemaToSchema<TupleSchema>, Relations>,
>(
	db: ReadOnlyTupleDatabaseClientApi<TupleSchema>,
	relations: Relations | undefined,
	query: Query,
): RelationalQueryResult<TupleSchemaToSchema<TupleSchema>, Relations, Query> {
	const runtimeQuery = query as unknown as RuntimeQuery
	const runtimeRelations = getRuntimeRelations(relations)
	const collections = getQueryCollections(runtimeQuery, runtimeRelations)
	const records = loadRecordsSync(db, collections)

	return executeLoadedQuery(
		runtimeQuery.collection,
		runtimeQuery,
		runtimeRelations,
		records,
	) as RelationalQueryResult<TupleSchemaToSchema<TupleSchema>, Relations, Query>
}

export async function executeQueryAsync<
	TupleSchema extends RecordTuple,
	Relations extends RuntimeRelationsDefinition<
		TupleSchemaToSchema<TupleSchema>
	>,
	Query extends RelationalQuery<TupleSchemaToSchema<TupleSchema>, Relations>,
>(
	db: ReadOnlyAsyncTupleDatabaseClientApi<TupleSchema>,
	relations: Relations | undefined,
	query: Query,
): Promise<
	RelationalQueryResult<TupleSchemaToSchema<TupleSchema>, Relations, Query>
> {
	const runtimeQuery = query as unknown as RuntimeQuery
	const runtimeRelations = getRuntimeRelations(relations)
	const collections = getQueryCollections(runtimeQuery, runtimeRelations)
	const records = await loadRecordsAsync(db, collections)

	return executeLoadedQuery(
		runtimeQuery.collection,
		runtimeQuery,
		runtimeRelations,
		records,
	) as RelationalQueryResult<TupleSchemaToSchema<TupleSchema>, Relations, Query>
}
