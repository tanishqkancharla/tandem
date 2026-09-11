import type {
	ReadOnlyAsyncTupleDatabaseClientApi,
	ReadOnlyTupleDatabaseClientApi,
} from "tuple-database"
import type {
	AnySchema,
	Attribute,
	CollectionName,
	AnyRelations,
	SchemaToTupleSchema,
} from "../schema/Schema"
import { isEqual, isObject, pick } from "../utils/objectUtils"
import type { RelationalQuery, RelationalQueryResult } from "./Query"

type RuntimeRecord = Record<string, unknown>

type AnyQueryInput<Schema extends AnySchema> = {
	readonly collection: CollectionName<Schema>
	readonly select?: Readonly<Partial<Record<Attribute<Schema>, true>>>
	readonly where?: Readonly<Partial<Record<Attribute<Schema>, unknown>>>
	readonly with?: Readonly<
		Record<string, true | Omit<AnyQueryInput<Schema>, "collection"> | undefined>
	>
	readonly orderBy?: Readonly<
		Partial<Record<Attribute<Schema>, "asc" | "desc">>
	>
	readonly limit?: number
	readonly offset?: number
}

type AnyQuery<Schema extends AnySchema> = Omit<
	AnyQueryInput<Schema>,
	"with"
> & {
	readonly with?: Readonly<Record<string, AnyQuery<Schema>>>
}

type RecordsByCollection<Schema extends AnySchema> = ReadonlyMap<
	CollectionName<Schema>,
	readonly RuntimeRecord[]
>

function normalizeQuery<
	Schema extends AnySchema,
	Relations extends AnyRelations<Schema>,
	Query extends RelationalQuery<Schema, Relations>,
>(query: Query, relations: Relations | undefined): AnyQuery<Schema>
function normalizeQuery<Schema extends AnySchema>(
	query: AnyQueryInput<Schema>,
	relations: AnyRelations<Schema> | undefined,
): AnyQuery<Schema>
function normalizeQuery<Schema extends AnySchema>(
	query: AnyQueryInput<Schema>,
	relations: AnyRelations<Schema> | undefined,
): AnyQuery<Schema> {
	const normalized = {
		collection: query.collection,
		select: query.select,
		where: query.where,
		orderBy: query.orderBy,
		limit: query.limit,
		offset: query.offset,
	}
	if (!query.with) return normalized

	if (!relations) {
		throw new Error(
			"Cannot execute relational query includes without relations",
		)
	}

	const withQueries: Record<string, AnyQuery<Schema>> = {}
	for (const [relationName, includeOptions] of Object.entries(query.with)) {
		if (!includeOptions) continue
		const relation = relations[query.collection]?.[relationName]
		if (!relation) {
			throw new Error(`Unknown relation "${query.collection}.${relationName}"`)
		}

		withQueries[relationName] = normalizeQuery(
			{
				collection: relation.targetCollection,
				...(includeOptions === true ? {} : includeOptions),
			},
			relations,
		)
	}

	return { ...normalized, with: withQueries }
}

function collectQueryCollections<Schema extends AnySchema>(
	query: AnyQuery<Schema>,
	collections: Set<CollectionName<Schema>>,
) {
	collections.add(query.collection)
	if (!query.with) return

	for (const nestedQuery of Object.values(query.with)) {
		collectQueryCollections(nestedQuery, collections)
	}
}

function getQueryCollections<Schema extends AnySchema>(
	query: AnyQuery<Schema>,
) {
	const collections = new Set<CollectionName<Schema>>()
	collectQueryCollections(query, collections)
	return collections
}

function scanCollectionSync<
	Schema extends AnySchema,
	Collection extends CollectionName<Schema>,
>(
	db: ReadOnlyTupleDatabaseClientApi<SchemaToTupleSchema<Schema>>,
	collection: Collection,
): RuntimeRecord[] {
	return db
		.scan<
			["record", Collection, Schema[Collection]["id"]],
			["record", Collection]
		>({ prefix: ["record", collection] })
		.map(({ value }) => value)
}

async function scanCollectionAsync<
	Schema extends AnySchema,
	Collection extends CollectionName<Schema>,
>(
	db: ReadOnlyAsyncTupleDatabaseClientApi<SchemaToTupleSchema<Schema>>,
	collection: Collection,
): Promise<RuntimeRecord[]> {
	const tuples = await db.scan<
		["record", Collection, Schema[Collection]["id"]],
		["record", Collection]
	>({ prefix: ["record", collection] })
	return tuples.map(({ value }) => value)
}

function mapEntry<Key, Value>(key: Key, value: Value): readonly [Key, Value] {
	return [key, value]
}

function loadRecordsSync<Schema extends AnySchema>(
	db: ReadOnlyTupleDatabaseClientApi<SchemaToTupleSchema<Schema>>,
	collections: ReadonlySet<CollectionName<Schema>>,
) {
	return new Map(
		Array.from(collections, (collection) => [
			collection,
			scanCollectionSync(db, collection),
		]),
	)
}

async function loadRecordsAsync<Schema extends AnySchema>(
	db: ReadOnlyAsyncTupleDatabaseClientApi<SchemaToTupleSchema<Schema>>,
	collections: ReadonlySet<CollectionName<Schema>>,
) {
	return new Map(
		await Promise.all(
			Array.from(collections, async (collection) =>
				mapEntry(collection, await scanCollectionAsync(db, collection)),
			),
		),
	)
}

function compareOrderedValues(left: unknown, right: unknown) {
	if (typeof left === "number" && typeof right === "number") {
		if (left > right) return 1
		if (left < right) return -1
		return 0
	}

	if (typeof left !== "string" || typeof right !== "string") return 0
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

	const comparison = compareOrderedValues(fieldValue, comparisonValue)
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

	if (isObject(condition) && !Array.isArray(condition)) {
		return Object.entries(condition).every(([operator, value]) =>
			compareRelationalValue(fieldValue, operator, value),
		)
	}

	return isEqual(fieldValue, condition)
}

function getRelationalRows<Schema extends AnySchema>(
	query: AnyQuery<Schema>,
	recordsByCollection: RecordsByCollection<Schema>,
	extraFilter?: (record: RuntimeRecord) => boolean,
) {
	const collectionRecords = recordsByCollection.get(query.collection) ?? []
	const relationFiltered = extraFilter
		? collectionRecords.filter(extraFilter)
		: [...collectionRecords]
	const whereFiltered = query.where
		? relationFiltered.filter((record) =>
				Object.entries(query.where ?? {}).every(([field, condition]) =>
					matchesRelationalWhere(record, field, condition),
				),
			)
		: relationFiltered
	const ordered = query.orderBy
		? [...whereFiltered].sort((left, right) => {
				for (const [field, direction] of Object.entries(query.orderBy ?? {})) {
					if (!direction) continue
					const comparison = compareOrderedValues(left[field], right[field])
					if (comparison !== 0) {
						return direction === "asc" ? comparison : -comparison
					}
				}
				return 0
			})
		: whereFiltered
	const offset =
		query.offset === undefined ? ordered : ordered.slice(query.offset)

	return query.limit === undefined ? offset : offset.slice(0, query.limit)
}

function executeLoadedQuery<
	Schema extends AnySchema,
	Relations extends AnyRelations<Schema>,
	Query extends RelationalQuery<Schema, Relations>,
>(
	query: AnyQuery<Schema>,
	relations: Relations | undefined,
	recordsByCollection: RecordsByCollection<Schema>,
	extraFilter?: (record: RuntimeRecord) => boolean,
): RelationalQueryResult<Schema, Relations, Query>
function executeLoadedQuery<Schema extends AnySchema>(
	query: AnyQuery<Schema>,
	relations: AnyRelations<Schema> | undefined,
	recordsByCollection: RecordsByCollection<Schema>,
	extraFilter?: (record: RuntimeRecord) => boolean,
): RuntimeRecord[]
function executeLoadedQuery<Schema extends AnySchema>(
	query: AnyQuery<Schema>,
	relations: AnyRelations<Schema> | undefined,
	recordsByCollection: RecordsByCollection<Schema>,
	extraFilter?: (record: RuntimeRecord) => boolean,
): RuntimeRecord[] {
	const rows = getRelationalRows(query, recordsByCollection, extraFilter)

	return rows.map((row) => {
		const result: RuntimeRecord = query.select
			? pick(row, Object.keys(query.select))
			: { ...row }
		if (!query.with) return result

		if (!relations) {
			throw new Error(
				"Cannot execute relational query includes without relations",
			)
		}

		for (const [relationName, nestedQuery] of Object.entries(query.with)) {
			const relation = relations[query.collection]?.[relationName]
			if (!relation) {
				throw new Error(
					`Unknown relation "${query.collection}.${relationName}"`,
				)
			}

			const joinValue = row[relation.from]
			const related = executeLoadedQuery(
				nestedQuery,
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
	Schema extends AnySchema,
	Relations extends AnyRelations<Schema>,
	Query extends RelationalQuery<Schema, Relations>,
>(
	db: ReadOnlyTupleDatabaseClientApi<SchemaToTupleSchema<Schema>>,
	relations: Relations | undefined,
	query: Query,
): RelationalQueryResult<Schema, Relations, Query> {
	const normalizedQuery = normalizeQuery(query, relations)
	const collections = getQueryCollections(normalizedQuery)
	const records = loadRecordsSync(db, collections)

	return executeLoadedQuery<Schema, Relations, Query>(
		normalizedQuery,
		relations,
		records,
	)
}

export async function executeQueryAsync<
	Schema extends AnySchema,
	Relations extends AnyRelations<Schema>,
	Query extends RelationalQuery<Schema, Relations>,
>(
	db: ReadOnlyAsyncTupleDatabaseClientApi<SchemaToTupleSchema<Schema>>,
	relations: Relations | undefined,
	query: Query,
): Promise<RelationalQueryResult<Schema, Relations, Query>> {
	const normalizedQuery = normalizeQuery(query, relations)
	const collections = getQueryCollections(normalizedQuery)
	const records = await loadRecordsAsync(db, collections)

	return executeLoadedQuery<Schema, Relations, Query>(
		normalizedQuery,
		relations,
		records,
	)
}
