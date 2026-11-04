import * as errore from "errore"
import type {
	ReadOnlyAsyncTupleDatabaseClientApi,
	ReadOnlyTupleDatabaseClientApi,
} from "tuple-database"
import type {
	AnySchema,
	CollectionId,
	CollectionIdPart,
	CollectionName,
	AnyRelations,
	SchemaToTupleSchema,
} from "../schema/Schema.js"
import { collectionIdToTuple } from "../schema/Schema.js"
import type { Tuple } from "tuple-database"
import { compareTuple } from "tuple-database/helpers/compareTuple.js"
import { isObject, pick } from "../utils/objectUtils.js"
import {
	indexValue,
	type IndexDefinition,
	type SchemaIndexes,
} from "./indexes.js"
import { match, unreachable } from "../utils/typeUtils.js"
import type {
	EncodedQuery,
	Operator,
	RelationalQuery,
	RelationalQueryResult,
	ScanWindow,
} from "./Query.js"

type RuntimeRecord = Record<string, unknown>

export class InvalidScanWindowError extends errore.createTaggedError({
	name: "InvalidScanWindowError",
	message: "$detail",
}) {}

type RelationalQueryInput<Schema extends AnySchema> = {
	readonly collection: CollectionName<Schema>
	readonly select?: Readonly<Record<string, true | undefined>>
	readonly where?: Readonly<Record<string, unknown>>
	readonly with?: Readonly<
		Record<
			string,
			true | Omit<RelationalQueryInput<Schema>, "collection"> | undefined
		>
	>
	readonly orderBy?: Readonly<Record<string, "asc" | "desc" | undefined>>
	readonly limit?: number
	readonly offset?: number
}

type QueryWhereClause = readonly [
	field: string,
	operator: Operator,
	value: unknown,
]

type QueryOrderClause = readonly [field: string, direction: "asc" | "desc"]

type QueryNode<
	Schema extends AnySchema,
	Collection extends CollectionName<Schema> = CollectionName<Schema>,
> = {
	readonly collection: Collection
	readonly select?: readonly string[]
	readonly where?: readonly QueryWhereClause[]
	readonly with?: Readonly<Record<string, QueryNode<Schema>>>
	readonly order?: readonly QueryOrderClause[]
	readonly limit?: number
	readonly offset?: number
}

export type ScanWindowRecord<
	Schema extends AnySchema,
	Collection extends CollectionName<Schema> = CollectionName<Schema>,
> = {
	[CurrentCollection in Collection]: {
		collection: CurrentCollection
		value: Schema[CurrentCollection]
	}
}[Collection]

function isRelationalWhereOperator(operator: string) {
	return (
		operator === "eq" ||
		operator === "gt" ||
		operator === "lt" ||
		operator === "gte" ||
		operator === "lte"
	)
}

function encodeRelationalWhereOperator(operator: string): Operator {
	if (operator === "eq") return "="
	if (operator === "gt") return ">"
	if (operator === "lt") return "<"
	if (operator === "gte") return ">="
	if (operator === "lte") return "<="
	throw new Error(`Unknown where operator "${operator}"`)
}

function normalizeRelationalQuery<
	Schema extends AnySchema,
	Relations extends AnyRelations<Schema>,
	Query extends RelationalQuery<Schema, Relations>,
>(query: Query, relations: Relations | undefined): QueryNode<Schema>
function normalizeRelationalQuery<Schema extends AnySchema>(
	query: RelationalQueryInput<Schema>,
	relations: AnyRelations<Schema> | undefined,
): QueryNode<Schema>
function normalizeRelationalQuery<Schema extends AnySchema>(
	query: RelationalQueryInput<Schema>,
	relations: AnyRelations<Schema> | undefined,
): QueryNode<Schema> {
	const select: string[] = []
	for (const field in query.select) {
		if (query.select[field]) select.push(field)
	}

	// Undefined conditions add no clause, as when a subscription encodes them.
	const where: QueryWhereClause[] = []
	for (const field in query.where) {
		const condition = query.where[field]
		if (condition === undefined) continue
		if (!isObject(condition) || Array.isArray(condition)) {
			where.push([field, "=", condition])
			continue
		}

		for (const operator in condition) {
			if (!isRelationalWhereOperator(operator)) {
				throw new Error(`Unknown where operator "${operator}"`)
			}
			if (condition[operator] === undefined) continue
			where.push([
				field,
				encodeRelationalWhereOperator(operator),
				condition[operator],
			])
		}
	}

	const order: QueryOrderClause[] = []
	for (const field in query.orderBy) {
		const direction = query.orderBy[field]
		if (direction) order.push([field, direction])
	}

	const normalized = {
		collection: query.collection,
		...(query.select ? { select } : {}),
		...(query.where ? { where } : {}),
		...(query.orderBy ? { order } : {}),
		...(query.limit === undefined ? {} : { limit: query.limit }),
		...(query.offset === undefined ? {} : { offset: query.offset }),
	}
	if (!query.with) return normalized
	if (!relations) {
		throw new Error(
			"Cannot execute relational query includes without relations",
		)
	}

	const withQueries: Record<string, QueryNode<Schema>> = {}
	for (const relationName in query.with) {
		const includeOptions = query.with[relationName]
		if (!includeOptions) continue
		const relation = relations[query.collection]?.[relationName]
		if (!relation) {
			throw new Error(`Unknown relation "${query.collection}.${relationName}"`)
		}

		withQueries[relationName] = normalizeRelationalQuery(
			{
				collection: relation.targetCollection,
				...(includeOptions === true ? {} : includeOptions),
			},
			relations,
		)
	}

	return { ...normalized, with: withQueries }
}

function normalizeEncodedQuery<Schema extends AnySchema>(
	query: EncodedQuery<Schema>,
	relations: AnyRelations<Schema>,
): QueryNode<Schema> | InvalidScanWindowError {
	const normalized = {
		collection: query.collection,
		...(query.select === undefined || query.select === "*"
			? {}
			: { select: query.select }),
		...(query.where?.length ? { where: query.where } : {}),
		...(query.order?.length ? { order: query.order } : {}),
		...(query.limit === undefined ? {} : { limit: query.limit }),
		...(query.offset === undefined ? {} : { offset: query.offset }),
	}
	if (!query.with) return normalized

	const withQueries: Record<string, QueryNode<Schema>> = {}
	for (const relationName in query.with) {
		const nestedQuery = query.with[relationName]
		const relation = relations[query.collection]?.[relationName]
		if (!relation) {
			return new InvalidScanWindowError({
				detail: `Unknown relation "${query.collection}.${relationName}"`,
			})
		}
		if (nestedQuery.collection !== relation.targetCollection) {
			return new InvalidScanWindowError({
				detail: `Relation "${query.collection}.${relationName}" targets collection "${relation.targetCollection}", not "${nestedQuery.collection}"`,
			})
		}

		const normalizedNested = normalizeEncodedQuery(nestedQuery, relations)
		if (normalizedNested instanceof Error) return normalizedNested
		withQueries[relationName] = normalizedNested
	}

	return { ...normalized, with: withQueries }
}

function collectQueryCollections<Schema extends AnySchema>(
	query: QueryNode<Schema>,
	collections: Set<CollectionName<Schema>>,
) {
	collections.add(query.collection)
	if (!query.with) return

	for (const nestedQuery of Object.values(query.with)) {
		collectQueryCollections(nestedQuery, collections)
	}
}

function getQueryCollections<Schema extends AnySchema>(
	queries: readonly QueryNode<Schema>[],
) {
	const collections = new Set<CollectionName<Schema>>()
	for (const query of queries) collectQueryCollections(query, collections)
	return collections
}

/** A read the executor needs. A driver performs it on sync or async storage. */
type QueryRead =
	| { type: "scan"; collection: string }
	| { type: "get"; keys: readonly RecordKey[] }
	| { type: "entries"; bounds: EntryBounds }

/** Index entry key bounds, with optional limit and direction. */
type EntryBounds = {
	gt?: readonly unknown[]
	gte?: readonly unknown[]
	lt?: readonly unknown[]
	lte?: readonly unknown[]
	limit?: number
	reverse?: boolean
}

/** `["record", collection, ...id]`, as tuple-database orders it. */
type RecordKey = readonly ["record", string, ...CollectionIdPart[]]

/**
 * A query plan. It yields the reads it needs and receives their results, so
 * the same plan runs against the client's synchronous database and the
 * server's asynchronous one.
 */
type QueryExecution<Result> = Generator<QueryRead, Result, unknown>

function* scanCollection(
	collection: string,
): QueryExecution<readonly RuntimeRecord[]> {
	return (yield { type: "scan", collection }) as RuntimeRecord[]
}

function* scanEntries(
	bounds: EntryBounds,
): QueryExecution<readonly (readonly unknown[])[]> {
	return (yield { type: "entries", bounds }) as (readonly unknown[])[]
}

function* getRecords(
	keys: readonly RecordKey[],
): QueryExecution<readonly (RuntimeRecord | undefined)[]> {
	if (!keys.length) return []
	return (yield { type: "get", keys }) as (RuntimeRecord | undefined)[]
}

type ScanResult = { records: RuntimeRecord[]; byId: Map<string, RuntimeRecord> }

type TupleRecordReader = {
	scan(
		args: { prefix: readonly unknown[] } | EntryBounds,
	): { key: readonly unknown[]; value: unknown }[]
	get(key: readonly unknown[]): unknown
}

type AsyncTupleRecordReader = {
	scan(
		args: { prefix: readonly unknown[] } | EntryBounds,
	): Promise<{ key: readonly unknown[]; value: unknown }[]>
	get(key: readonly unknown[]): Promise<unknown>
}

function scanResult(tuples: { key: readonly unknown[]; value: unknown }[]) {
	const result: ScanResult = { records: [], byId: new Map() }
	for (const { key, value } of tuples) {
		result.records.push(value as RuntimeRecord)
		result.byId.set(JSON.stringify(key.slice(2)), value as RuntimeRecord)
	}
	return result
}

/**
 * Runs a plan on the client's database. Reads stay inside the tuple-database
 * client, so a subscription re-runs when any record it read changes. A whole
 * collection is scanned at most once per run and answers later key reads.
 */
function runSync<Schema extends AnySchema, Result>(
	db: ReadOnlyTupleDatabaseClientApi<SchemaToTupleSchema<Schema>>,
	execution: QueryExecution<Result>,
): Result {
	const reader = db as unknown as TupleRecordReader
	const scans = new Map<string, ScanResult>()
	let step = execution.next()
	while (!step.done) {
		const read = step.value
		switch (read.type) {
			case "scan": {
				const scanned =
					scans.get(read.collection) ??
					scanResult(reader.scan({ prefix: ["record", read.collection] }))
				scans.set(read.collection, scanned)
				step = execution.next(scanned.records)
				break
			}
			case "get":
				step = execution.next(
					read.keys.map(
						(key) =>
							scans.get(key[1])?.byId.get(JSON.stringify(key.slice(2))) ??
							(scans.has(key[1])
								? undefined
								: (reader.get(key) as RuntimeRecord | undefined)),
					),
				)
				break
			case "entries":
				step = execution.next(reader.scan(read.bounds).map(({ key }) => key))
				break
			default:
				unreachable(read)
		}
	}
	return step.value
}

/** Runs a plan on the server's storage, reading a batch of keys together. */
async function runAsync<Schema extends AnySchema, Result>(
	db: ReadOnlyAsyncTupleDatabaseClientApi<SchemaToTupleSchema<Schema>>,
	execution: QueryExecution<Result>,
): Promise<Result> {
	const reader = db as unknown as AsyncTupleRecordReader
	const scans = new Map<string, ScanResult>()
	let step = execution.next()
	while (!step.done) {
		const read = step.value
		switch (read.type) {
			case "scan": {
				const scanned =
					scans.get(read.collection) ??
					scanResult(await reader.scan({ prefix: ["record", read.collection] }))
				scans.set(read.collection, scanned)
				step = execution.next(scanned.records)
				break
			}
			case "get":
				step = execution.next(
					await Promise.all(
						read.keys.map((key) =>
							scans.has(key[1])
								? Promise.resolve(
										scans.get(key[1])!.byId.get(JSON.stringify(key.slice(2))),
									)
								: (reader.get(key) as Promise<RuntimeRecord | undefined>),
						),
					),
				)
				break
			case "entries":
				step = execution.next(
					(await reader.scan(read.bounds)).map(({ key }) => key),
				)
				break
			default:
				unreachable(read)
		}
	}
	return step.value
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

/**
 * Equality for `where`: primitives compare with `===`, objects and arrays by
 * their JSON. Values of different types never match, so a key or index read
 * finds every match.
 */
function queryValuesEqual(left: unknown, right: unknown) {
	if (left === right) return true
	return (
		typeof left === "object" &&
		left !== null &&
		typeof right === "object" &&
		right !== null &&
		JSON.stringify(left) === JSON.stringify(right)
	)
}

function compareQueryValue(
	fieldValue: unknown,
	operator: Operator,
	comparisonValue: unknown,
) {
	if (operator === "=") return queryValuesEqual(fieldValue, comparisonValue)

	const comparison = compareOrderedValues(fieldValue, comparisonValue)
	if (operator === ">") return comparison > 0
	if (operator === "<") return comparison < 0
	if (operator === ">=") return comparison >= 0
	return comparison <= 0
}

function matchesWhere(record: RuntimeRecord, clause: QueryWhereClause) {
	const [field, operator, comparisonValue] = clause
	return compareQueryValue(record[field], operator, comparisonValue)
}

/** Applies a node's filters, ordering, offset, and limit to candidates in key order. */
function selectRows(
	query: QueryNode<AnySchema>,
	candidates: readonly RuntimeRecord[],
) {
	const filtered = query.where
		? candidates.filter((record) =>
				query.where!.every((clause) => matchesWhere(record, clause)),
			)
		: [...candidates]
	const ordered = query.order
		? filtered.sort((left, right) => {
				for (const [field, direction] of query.order ?? []) {
					const comparison = compareOrderedValues(left[field], right[field])
					if (comparison !== 0) {
						return match(direction, { asc: comparison, desc: -comparison })
					}
				}
				return 0
			})
		: filtered
	const offset =
		query.offset === undefined ? ordered : ordered.slice(query.offset)
	return query.limit === undefined ? offset : offset.slice(0, query.limit)
}

/** A key part that a stored record ID can hold. */
function isIdPart(value: unknown): value is CollectionIdPart {
	return (
		typeof value === "string" ||
		(typeof value === "number" && !Number.isNaN(value))
	)
}

/** The record key an ID equality names, if the value is a possible ID. */
function idKey(collection: string, id: unknown): RecordKey | undefined {
	if (isIdPart(id)) return ["record", collection, id]
	if (Array.isArray(id) && id.length > 0 && id.every(isIdPart))
		return ["record", collection, ...id]
	return undefined
}

/**
 * A root node's candidates: one key read when it filters on a full ID, then
 * a usable index, otherwise the whole collection. Every where clause still
 * runs on them.
 */
function* rootCandidates(
	query: QueryNode<AnySchema>,
	indexes: SchemaIndexes,
): QueryExecution<readonly RuntimeRecord[]> {
	const idClause = query.where?.find(
		([field, operator]) => field === "id" && operator === "=",
	)
	const key = idClause && idKey(query.collection, idClause[2])
	if (key) {
		const [record] = yield* getRecords([key])
		return record ? [record] : []
	}
	const plan = planIndex(query, indexes)
	const indexed = plan && (yield* indexCandidates(query, plan))
	return indexed ?? (yield* scanCollection(query.collection))
}

/** tuple-database's largest key suffix: every key continuing a prefix sorts below it. */
const afterAll: readonly unknown[] = Array.from({ length: 10 }, () => true)

type IndexPlan = {
	index: IndexDefinition
	/** `["index", collection, name, ...equality values]`. */
	prefix: readonly unknown[]
	/** Range clauses on the field after the prefix, all of one type. */
	lower?: { value: string | number; inclusive: boolean }
	upper?: { value: string | number; inclusive: boolean }
	rangeType?: "string" | "number"
	/** Set when the query orders by that field alone and has a limit. */
	order?: "asc" | "desc"
}

/** Values whose `===` matches exactly the entries with the same key value. */
function isEqualityValue(value: unknown): value is string | number | boolean {
	return (
		typeof value === "string" ||
		typeof value === "boolean" ||
		(typeof value === "number" && Number.isFinite(value))
	)
}

/** Values on whose order the query comparison and entry order agree. */
function isRangeValue(value: unknown): value is string | number {
	return (
		typeof value === "string" ||
		(typeof value === "number" && Number.isFinite(value))
	)
}

/**
 * The index whose leading fields the query fixes with equality, then
 * narrows or orders on the next field, if any index helps.
 */
function planIndex(
	query: QueryNode<AnySchema>,
	indexes: SchemaIndexes,
): IndexPlan | undefined {
	let best: { plan: IndexPlan; score: number } | undefined
	for (const index of indexes.get(query.collection) ?? []) {
		const values: unknown[] = []
		for (const field of index.fields) {
			const clause = query.where?.find(
				([name, operator, value]) =>
					name === field && operator === "=" && isEqualityValue(value),
			)
			if (!clause) break
			values.push(indexValue(clause[2]))
		}
		const plan: IndexPlan = {
			index,
			prefix: ["index", query.collection, index.name, ...values],
		}
		const next = index.fields[values.length]
		for (const [field, operator, value] of query.where ?? []) {
			if (field !== next || operator === "=") continue
			const type = typeof value
			if (
				!isRangeValue(value) ||
				(plan.rangeType !== undefined && plan.rangeType !== type)
			) {
				// Clauses that compare across types match nothing or everything.
				delete plan.lower
				delete plan.upper
				delete plan.rangeType
				break
			}
			plan.rangeType = type as "string" | "number"
			const inclusive = operator === ">=" || operator === "<="
			if ((operator === ">" || operator === ">=") && !plan.lower)
				plan.lower = { value, inclusive }
			if ((operator === "<" || operator === "<=") && !plan.upper)
				plan.upper = { value, inclusive }
		}
		const [order] = query.order ?? []
		if (
			next !== undefined &&
			query.order?.length === 1 &&
			order?.[0] === next &&
			query.limit !== undefined
		)
			plan.order = order[1]
		const ranged = plan.lower || plan.upper
		const score = values.length * 4 + (ranged ? 2 : 0) + (plan.order ? 1 : 0)
		if (score > 0 && (!best || score > best.score)) best = { plan, score }
	}
	return best?.plan
}

function entryRecordKey(index: IndexDefinition, entry: readonly unknown[]) {
	return [
		"record",
		index.collection,
		...entry.slice(3 + index.fields.length),
	] as unknown as RecordKey
}

function inKeyOrder(records: RuntimeRecord[]) {
	return records.sort((left, right) =>
		compareTuple(
			collectionIdToTuple(left.id as CollectionId),
			collectionIdToTuple(right.id as CollectionId),
		),
	)
}

/**
 * Candidates read through an index: a superset of the query's matches, in
 * key order, so ordering and paging give the same rows as a scan. Returns
 * undefined when only a scan is sure to.
 */
function* indexCandidates(
	query: QueryNode<AnySchema>,
	plan: IndexPlan,
): QueryExecution<RuntimeRecord[] | undefined> {
	const { index, prefix } = plan
	const everything = { gte: prefix, lte: [...prefix, ...afterAll] }
	let { lower, upper, order } = plan
	if (lower || upper || order) {
		// Entry order matches query order only if every value under the
		// prefix is a string, or every one a number. Entries sort by type
		// first, so the first and last tell.
		const [first] = yield* scanEntries({ ...everything, limit: 1 })
		if (!first) return []
		const [last] = yield* scanEntries({
			...everything,
			limit: 1,
			reverse: true,
		})
		const type = typeof first[prefix.length]
		const uniform =
			(type === "string" || type === "number") &&
			typeof last?.[prefix.length] === type &&
			(plan.rangeType === undefined || plan.rangeType === type)
		if (!uniform) {
			// Without equality values, the entries would be the whole collection.
			if (prefix.length === 3) return undefined
			lower = undefined
			upper = undefined
			order = undefined
		}
	}
	const bounds: EntryBounds = {
		...(lower
			? lower.inclusive
				? { gte: [...prefix, lower.value] }
				: { gt: [...prefix, lower.value, ...afterAll] }
			: { gte: prefix }),
		...(upper
			? upper.inclusive
				? { lte: [...prefix, upper.value, ...afterAll] }
				: { lt: [...prefix, upper.value] }
			: { lte: [...prefix, ...afterAll] }),
	}
	// A lower bound above the upper one selects nothing; storage rejects it.
	const start = bounds.gt ?? bounds.gte
	const end = bounds.lt ?? bounds.lte
	if (start && end && compareTuple(start as Tuple, end as Tuple) > 0) return []
	if (order)
		return yield* orderedCandidates(query, index, prefix.length, bounds, order)
	const entries = yield* scanEntries(bounds)
	const records = yield* getRecords(
		entries.map((entry) => entryRecordKey(index, entry)),
	)
	return inKeyOrder(
		records.filter((record): record is RuntimeRecord => record !== undefined),
	)
}

/**
 * Reads entries in the query's order until offset + limit rows match, then
 * the rest of the last row's tie group. Sorted the query's way, those rows
 * begin exactly as the full sorted result does. Returns undefined if an
 * entry disagrees with its record, as after a write outside Tandem.
 */
function* orderedCandidates(
	query: QueryNode<AnySchema>,
	index: IndexDefinition,
	position: number,
	bounds: EntryBounds,
	order: "asc" | "desc",
): QueryExecution<RuntimeRecord[] | undefined> {
	const needed = (query.offset ?? 0) + (query.limit ?? 0)
	const field = index.fields[position - 3]!
	const reverse = order === "desc"
	const collected: RuntimeRecord[] = []
	let boundary: unknown
	let cursor = bounds
	for (;;) {
		// Read the entries still needed, plus one to see where a tie ends.
		const limit = Math.max(needed - collected.length, 1) + 1
		const entries = yield* scanEntries({ ...cursor, limit, reverse })
		const tied = entries.findIndex(
			(entry) => boundary !== undefined && entry[position] !== boundary,
		)
		const relevant = tied === -1 ? entries : entries.slice(0, tied)
		const records = yield* getRecords(
			relevant.map((entry) => entryRecordKey(index, entry)),
		)
		for (const [offset, entry] of relevant.entries()) {
			const value = entry[position]
			if (boundary !== undefined && value !== boundary)
				return inKeyOrder(collected)
			const record = records[offset]
			if (!record || indexValue(record[field]) !== value) return undefined
			if (!(query.where ?? []).every((clause) => matchesWhere(record, clause)))
				continue
			collected.push(record)
			if (boundary === undefined && collected.length >= needed) boundary = value
		}
		const last = entries.at(-1)
		if (!last || relevant.length < entries.length || entries.length < limit)
			return inKeyOrder(collected)
		const { gt, gte, lt, lte, ...rest } = cursor
		cursor = reverse
			? { ...rest, ...(gt && { gt }), ...(gte && { gte }), lt: last }
			: { ...rest, ...(lt && { lt }), ...(lte && { lte }), gt: last }
	}
}

type AnyRelation = NonNullable<
	NonNullable<AnyRelations<AnySchema>[string]>[string]
>

/**
 * Each parent's related candidates, in key order. A many-to-one relation
 * reads its distinct target IDs together; a one-to-many relation reads the
 * target collection once and groups it by the join field. Joins compare with
 * `===`, as before.
 */
function* relatedCandidates(
	relation: AnyRelation,
	parents: readonly RuntimeRecord[],
	indexes: SchemaIndexes,
): QueryExecution<readonly (readonly RuntimeRecord[])[]> {
	const target = relation.targetCollection
	if (relation.type === "many-to-one") {
		const joins = parents.map((parent) => parent[relation.from])
		const keys = new Map<string, RecordKey>()
		for (const join of joins)
			if (isIdPart(join))
				keys.set(JSON.stringify(join), ["record", target, join])
		const read = yield* getRecords([...keys.values()])
		const byJoin = new Map(
			[...keys.keys()].map((join, index) => [join, read[index]]),
		)
		// A join value that is not a key part can only match by reference.
		const scanned = joins.some(
			(join) => typeof join === "object" && join !== null,
		)
			? yield* scanCollection(target)
			: []
		return joins.map((join) => {
			const candidates = isIdPart(join)
				? [byJoin.get(JSON.stringify(join))]
				: scanned.filter((record) => record[relation.to] === join)
			return candidates.filter(
				(record): record is RuntimeRecord =>
					record !== undefined && record[relation.to] === join,
			)
		})
	}
	const indexed = yield* indexedChildren(relation, parents, indexes)
	if (indexed) return indexed
	const records = yield* scanCollection(target)
	const groups = new Map<unknown, RuntimeRecord[]>()
	const others: RuntimeRecord[] = []
	for (const record of records) {
		const join = record[relation.to]
		if (typeof join === "object" || Number.isNaN(join)) {
			others.push(record)
			continue
		}
		const group = groups.get(join) ?? []
		group.push(record)
		groups.set(join, group)
	}
	return parents.map((parent) => {
		const join = parent[relation.from]
		return typeof join === "object" || Number.isNaN(join)
			? others.filter((record) => record[relation.to] === join)
			: (groups.get(join) ?? [])
	})
}

/** Parents up to which a one-to-many include reads one entry range each. */
const maxIndexedParents = 64

/**
 * One-to-many candidates through an index that starts with the join field:
 * one entry range per distinct parent ID, instead of the whole target.
 */
function* indexedChildren(
	relation: AnyRelation,
	parents: readonly RuntimeRecord[],
	indexes: SchemaIndexes,
): QueryExecution<readonly (readonly RuntimeRecord[])[] | undefined> {
	const index = indexes
		.get(relation.targetCollection)
		?.find(({ fields }) => fields[0] === relation.to)
	const joins = parents.map((parent) => parent[relation.from])
	if (!index || !joins.every(isEqualityValue)) return
	const distinct = [...new Set(joins)]
	if (distinct.length > maxIndexedParents) return
	const ranges: (readonly unknown[])[][] = []
	for (const join of distinct) {
		const prefix = ["index", index.collection, index.name, indexValue(join)]
		ranges.push([
			...(yield* scanEntries({ gte: prefix, lte: [...prefix, ...afterAll] })),
		])
	}
	const records = yield* getRecords(
		ranges.flat().map((entry) => entryRecordKey(index, entry)),
	)
	const byJoin = new Map<unknown, RuntimeRecord[]>()
	let next = 0
	for (const [position, join] of distinct.entries()) {
		const found = records.slice(next, next + ranges[position]!.length)
		next += ranges[position]!.length
		byJoin.set(
			join,
			inKeyOrder(
				found.filter(
					(record): record is RuntimeRecord =>
						record !== undefined && record[relation.to] === join,
				),
			),
		)
	}
	return joins.map((join) => byJoin.get(join) ?? [])
}

/** A result row with the stored record behind it and its related rows. */
type RowTree = {
	row: RuntimeRecord
	result: RuntimeRecord
	related: RowTree[][]
}

/** Builds result rows level by level, so each include reads once for all parents. */
function* materializeRows(
	query: QueryNode<AnySchema>,
	relations: AnyRelations<AnySchema> | undefined,
	rows: readonly RuntimeRecord[],
	indexes: SchemaIndexes,
): QueryExecution<RowTree[]> {
	const trees: RowTree[] = rows.map((row) => ({
		row,
		result: query.select ? pick(row, query.select) : { ...row },
		related: [],
	}))
	// Without parent rows, includes have nothing to join, so they read nothing.
	if (!query.with || !rows.length) return trees
	if (!relations) {
		throw new Error(
			"Cannot execute relational query includes without relations",
		)
	}
	for (const [relationName, nested] of Object.entries(query.with)) {
		const relation = relations[query.collection]?.[relationName]
		if (!relation) {
			throw new Error(`Unknown relation "${query.collection}.${relationName}"`)
		}
		const candidates = yield* relatedCandidates(relation, rows, indexes)
		const perParent = candidates.map((related) => selectRows(nested, related))
		const children = yield* materializeRows(
			nested,
			relations,
			perParent.flat(),
			indexes,
		)
		let next = 0
		for (const [index, related] of perParent.entries()) {
			const mine = children.slice(next, next + related.length)
			next += related.length
			const tree = trees[index]!
			tree.related.push(mine)
			tree.result[relationName] = match<unknown>(relation.type, {
				"many-to-one": mine[0]?.result ?? null,
				"one-to-many": mine.map(({ result }) => result),
			})
		}
	}
	return trees
}

function* executeNode(
	query: QueryNode<AnySchema>,
	relations: AnyRelations<AnySchema> | undefined,
	indexes: SchemaIndexes,
): QueryExecution<RowTree[]> {
	const candidates = yield* rootCandidates(query, indexes)
	return yield* materializeRows(
		query,
		relations,
		selectRows(query, candidates),
		indexes,
	)
}

export function executeQuerySync<
	Schema extends AnySchema,
	Relations extends AnyRelations<Schema>,
	Query extends RelationalQuery<Schema, Relations>,
>(
	db: ReadOnlyTupleDatabaseClientApi<SchemaToTupleSchema<Schema>>,
	relations: Relations | undefined,
	query: Query,
	indexes: SchemaIndexes = new Map(),
): RelationalQueryResult<Schema, Relations, Query> {
	const normalized = normalizeRelationalQuery(query, relations)
	const trees = runSync(db, executeNode(normalized, relations, indexes))
	return trees.map(({ result }) => result) as RelationalQueryResult<
		Schema,
		Relations,
		Query
	>
}

export async function executeQueryAsync<
	Schema extends AnySchema,
	Relations extends AnyRelations<Schema>,
	Query extends RelationalQuery<Schema, Relations>,
>(
	db: ReadOnlyAsyncTupleDatabaseClientApi<SchemaToTupleSchema<Schema>>,
	relations: Relations | undefined,
	query: Query,
	indexes: SchemaIndexes = new Map(),
): Promise<RelationalQueryResult<Schema, Relations, Query>> {
	const normalized = normalizeRelationalQuery(query, relations)
	const trees = await runAsync(db, executeNode(normalized, relations, indexes))
	return trees.map(({ result }) => result) as RelationalQueryResult<
		Schema,
		Relations,
		Query
	>
}

function normalizeScanWindow<Schema extends AnySchema>(
	scanWindow: ScanWindow<Schema>,
	relations: AnyRelations<Schema>,
): QueryNode<Schema>[] | InvalidScanWindowError {
	const queries: QueryNode<Schema>[] = []
	for (const query of scanWindow) {
		const normalized = normalizeEncodedQuery(query, relations)
		if (normalized instanceof Error) return normalized
		queries.push(normalized)
	}
	return queries
}

function createScanWindowRecord<
	Schema extends AnySchema,
	Collection extends CollectionName<Schema>,
>(
	collection: Collection,
	value: Schema[Collection],
): ScanWindowRecord<Schema, Collection> {
	return { collection, value }
}

/**
 * Every record the window's queries read, rows before an offset included,
 * each once, in the order a depth-first walk of the results meets them.
 */
function* collectScanWindow<Schema extends AnySchema>(
	queries: readonly QueryNode<Schema>[],
	relations: AnyRelations<Schema>,
	indexes: SchemaIndexes,
): QueryExecution<ScanWindowRecord<Schema>[]> {
	const result: ScanWindowRecord<Schema>[] = []
	const seen = new Set<string>()
	const visit = (
		collection: CollectionName<Schema>,
		tree: RowTree,
		query: QueryNode<Schema>,
	) => {
		const id = JSON.stringify([
			collection,
			...collectionIdToTuple(tree.row.id as CollectionId),
		])
		if (!seen.has(id)) {
			seen.add(id)
			result.push(
				createScanWindowRecord(
					collection,
					tree.row as Schema[CollectionName<Schema>],
				),
			)
		}
		const nested = Object.values(query.with ?? {})
		for (const [index, related] of tree.related.entries())
			for (const child of related)
				visit(nested[index]!.collection, child, nested[index]!)
	}
	for (const query of queries) {
		const prefixed = windowQueryPrefix(query)
		const trees = yield* executeNode(prefixed, relations, indexes)
		for (const tree of trees) visit(prefixed.collection, tree, prefixed)
	}
	return result
}

/** Keep rows before an offset so the client can apply its own page offset. */
function windowQueryPrefix<Schema extends AnySchema>(
	query: QueryNode<Schema>,
): QueryNode<Schema> {
	return {
		...query,
		...(query.offset === undefined
			? {}
			: {
					offset: 0,
					...(query.limit === undefined
						? {}
						: { limit: query.offset + query.limit }),
				}),
		...(query.with === undefined
			? {}
			: {
					with: Object.fromEntries(
						Object.entries(query.with).map(([name, child]) => [
							name,
							windowQueryPrefix(child),
						]),
					),
				}),
	}
}

export function executeScanWindowAsync<
	Schema extends AnySchema,
	Relations extends AnyRelations<Schema>,
>(
	db: ReadOnlyAsyncTupleDatabaseClientApi<SchemaToTupleSchema<Schema>>,
	relations: Relations,
	scanWindow: ScanWindow<Schema>,
	indexes: SchemaIndexes = new Map(),
): Promise<ScanWindowRecord<Schema>[] | InvalidScanWindowError> {
	const queries = normalizeScanWindow(scanWindow, relations)
	if (queries instanceof Error) return Promise.resolve(queries)
	return runAsync(db, collectScanWindow(queries, relations, indexes))
}

export function executeScanWindowSync<
	Schema extends AnySchema,
	Relations extends AnyRelations<Schema>,
>(
	db: ReadOnlyTupleDatabaseClientApi<SchemaToTupleSchema<Schema>>,
	relations: Relations,
	scanWindow: ScanWindow<Schema>,
	indexes: SchemaIndexes = new Map(),
): ScanWindowRecord<Schema>[] | InvalidScanWindowError {
	const queries = normalizeScanWindow(scanWindow, relations)
	if (queries instanceof Error) return queries
	return runSync(db, collectScanWindow(queries, relations, indexes))
}

/** What a scan window reads, without running it. */
export type ScanWindowDependencies<Schema extends AnySchema> = {
	/** Every collection a query reads, at any include depth. */
	collections: Set<CollectionName<Schema>>
	/**
	 * Per collection, the fields that decide which records a query selects or
	 * how it orders them: filters, ordering, and relation joins.
	 */
	membershipFields: Map<CollectionName<Schema>, Set<string>>
	/**
	 * Per collection, the collections whose other records can change which of
	 * its records a query selects: its own under a limit or offset, and every
	 * collection an include of it hangs from.
	 */
	membershipCollections: Map<
		CollectionName<Schema>,
		Set<CollectionName<Schema>>
	>
}

export function scanWindowDependencies<Schema extends AnySchema>(
	scanWindow: ScanWindow<Schema>,
	relations: AnyRelations<Schema>,
): ScanWindowDependencies<Schema> | InvalidScanWindowError {
	const queries = normalizeScanWindow(scanWindow, relations)
	if (queries instanceof Error) return queries
	const dependencies: ScanWindowDependencies<Schema> = {
		collections: getQueryCollections(queries),
		membershipFields: new Map(),
		membershipCollections: new Map(),
	}
	const addField = (collection: CollectionName<Schema>, field: string) => {
		const fields = dependencies.membershipFields.get(collection) ?? new Set()
		fields.add(field)
		dependencies.membershipFields.set(collection, fields)
	}
	const visit = (
		query: QueryNode<Schema>,
		ancestors: readonly CollectionName<Schema>[],
	) => {
		for (const [field] of query.where ?? []) addField(query.collection, field)
		for (const [field] of query.order ?? []) addField(query.collection, field)
		const collections =
			dependencies.membershipCollections.get(query.collection) ?? new Set()
		for (const ancestor of ancestors) collections.add(ancestor)
		if (query.limit !== undefined || query.offset !== undefined)
			collections.add(query.collection)
		dependencies.membershipCollections.set(query.collection, collections)
		for (const [relationName, nested] of Object.entries(query.with ?? {})) {
			const relation = relations[query.collection]?.[relationName]
			if (relation) {
				addField(query.collection, relation.from)
				addField(relation.targetCollection, relation.to)
			}
			visit(nested, [...ancestors, query.collection])
		}
	}
	for (const query of queries) visit(query, [])
	return dependencies
}
