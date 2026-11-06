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
import { isObject, pick } from "../utils/objectUtils.js"
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

/**
 * A read that storage with a native query engine may answer without reading
 * the whole collection. The answer must hold every record of `collection` that
 * the query node could return, in key order. It may hold more: the executor
 * filters, orders, and limits the records again.
 */
export type CandidateRead = {
	readonly collection: string
	/** Clauses every returned record matches. */
	readonly where: readonly QueryWhereClause[]
	readonly order: readonly QueryOrderClause[]
	/** Results the node needs from the start of `order`, offset rows included. */
	readonly limit?: number
	/** Only records whose `field` is `===` one of `values`. */
	readonly join?: {
		readonly field: string
		readonly values: readonly unknown[]
	}
}

/**
 * Answers a candidate read with `["record", collection, ...id]` tuples, or
 * undefined when the storage cannot answer it exactly; the executor then reads
 * the whole collection.
 */
export type ReadCandidates = (
	read: CandidateRead,
) => Promise<readonly { key: readonly unknown[]; value: unknown }[] | undefined>

/** A read the executor needs. A driver performs it on sync or async storage. */
type QueryRead =
	| { type: "scan"; collection: string }
	| { type: "candidates"; read: CandidateRead }
	| { type: "get"; keys: readonly RecordKey[] }

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

function* readCandidates(
	read: CandidateRead,
): QueryExecution<readonly RuntimeRecord[]> {
	return (yield { type: "candidates", read }) as RuntimeRecord[]
}

function* getRecords(
	keys: readonly RecordKey[],
): QueryExecution<readonly (RuntimeRecord | undefined)[]> {
	if (!keys.length) return []
	return (yield { type: "get", keys }) as (RuntimeRecord | undefined)[]
}

type ScanResult = { records: RuntimeRecord[]; byId: Map<string, RuntimeRecord> }

type TupleRecordReader = {
	scan(args: {
		prefix: readonly unknown[]
	}): { key: readonly unknown[]; value: unknown }[]
	get(key: readonly unknown[]): unknown
}

type AsyncTupleRecordReader = {
	scan(args: {
		prefix: readonly unknown[]
		limit?: number
	}): Promise<{ key: readonly unknown[]; value: unknown }[]>
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
	const scan = (collection: string) => {
		const scanned =
			scans.get(collection) ??
			scanResult(reader.scan({ prefix: ["record", collection] }))
		scans.set(collection, scanned)
		return scanned.records
	}
	let step = execution.next()
	while (!step.done) {
		const read = step.value
		switch (read.type) {
			case "scan":
				step = execution.next(scan(read.collection))
				break
			// The client's database is in memory: a scan costs no more.
			case "candidates":
				step = execution.next(scan(read.read.collection))
				break
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
			default:
				unreachable(read)
		}
	}
	return step.value
}

/**
 * Runs a plan on the server's storage, reading a batch of keys together.
 * Candidate reads go to `candidates` when given, after an empty scan of the
 * collection: it reads no records but registers the collection with the
 * client's subscription and conflict tracking, as the full scan would.
 */
async function runAsync<Schema extends AnySchema, Result>(
	db: ReadOnlyAsyncTupleDatabaseClientApi<SchemaToTupleSchema<Schema>>,
	execution: QueryExecution<Result>,
	candidates: ReadCandidates | undefined,
): Promise<Result> {
	const reader = db as unknown as AsyncTupleRecordReader
	const scans = new Map<string, ScanResult>()
	const scan = async (collection: string) => {
		const scanned =
			scans.get(collection) ??
			scanResult(await reader.scan({ prefix: ["record", collection] }))
		scans.set(collection, scanned)
		return scanned.records
	}
	let step = execution.next()
	while (!step.done) {
		const read = step.value
		switch (read.type) {
			case "scan":
				step = execution.next(await scan(read.collection))
				break
			case "candidates": {
				const { collection } = read.read
				if (scans.has(collection) || !candidates) {
					step = execution.next(await scan(collection))
					break
				}
				await reader.scan({ prefix: ["record", collection], limit: 0 })
				const tuples = await candidates(read.read)
				step = execution.next(
					tuples ? tuples.map(({ value }) => value) : await scan(collection),
				)
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
 * A root node's candidates: one key read when it filters on a full ID,
 * otherwise a candidate read. Every where clause still runs on them.
 */
function* rootCandidates(
	query: QueryNode<AnySchema>,
): QueryExecution<readonly RuntimeRecord[]> {
	const idClause = query.where?.find(
		([field, operator]) => field === "id" && operator === "=",
	)
	const key = idClause && idKey(query.collection, idClause[2])
	// Scan windows come from clients, so a page may not be a count.
	const offset = query.offset ?? 0
	if (!key)
		return yield* readCandidates({
			collection: query.collection,
			where: query.where ?? [],
			order: query.order ?? [],
			...(isCount(offset) &&
				isCount(query.limit) && { limit: offset + query.limit }),
		})
	const [record] = yield* getRecords([key])
	return record ? [record] : []
}

function isCount(value: unknown): value is number {
	return Number.isSafeInteger(value) && (value as number) >= 0
}

type AnyRelation = NonNullable<
	NonNullable<AnyRelations<AnySchema>[string]>[string]
>

/**
 * Each parent's related candidates, in key order. A many-to-one relation
 * reads its distinct target IDs together; a one-to-many relation makes one
 * candidate read for every parent's join value and groups the result by the
 * join field. Joins compare with `===`, as before.
 */
function* relatedCandidates(
	relation: AnyRelation,
	nested: QueryNode<AnySchema>,
	parents: readonly RuntimeRecord[],
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
	const records = yield* readCandidates({
		collection: target,
		where: nested.where ?? [],
		order: [],
		join: {
			field: relation.to,
			values: [...new Set(parents.map((parent) => parent[relation.from]))],
		},
	})
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
		const candidates = yield* relatedCandidates(relation, nested, rows)
		const perParent = candidates.map((related) => selectRows(nested, related))
		const children = yield* materializeRows(nested, relations, perParent.flat())
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
): QueryExecution<RowTree[]> {
	const candidates = yield* rootCandidates(query)
	return yield* materializeRows(query, relations, selectRows(query, candidates))
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
	const normalized = normalizeRelationalQuery(query, relations)
	const trees = runSync(db, executeNode(normalized, relations))
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
	candidates?: ReadCandidates,
): Promise<RelationalQueryResult<Schema, Relations, Query>> {
	const normalized = normalizeRelationalQuery(query, relations)
	const trees = await runAsync(
		db,
		executeNode(normalized, relations),
		candidates,
	)
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
		const trees = yield* executeNode(prefixed, relations)
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
	candidates?: ReadCandidates,
): Promise<ScanWindowRecord<Schema>[] | InvalidScanWindowError> {
	const queries = normalizeScanWindow(scanWindow, relations)
	if (queries instanceof Error) return Promise.resolve(queries)
	return runAsync(db, collectScanWindow(queries, relations), candidates)
}

export function executeScanWindowSync<
	Schema extends AnySchema,
	Relations extends AnyRelations<Schema>,
>(
	db: ReadOnlyTupleDatabaseClientApi<SchemaToTupleSchema<Schema>>,
	relations: Relations,
	scanWindow: ScanWindow<Schema>,
): ScanWindowRecord<Schema>[] | InvalidScanWindowError {
	const queries = normalizeScanWindow(scanWindow, relations)
	if (queries instanceof Error) return queries
	return runSync(db, collectScanWindow(queries, relations))
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
