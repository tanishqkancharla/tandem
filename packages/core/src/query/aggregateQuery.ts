import type { TupleDatabaseClient } from "tuple-database"
import {
	collectionIdToTuple,
	type AnySchema,
	type CollectionId,
	type CollectionName,
	type SchemaToTupleSchema,
} from "../schema/Schema.js"
import { isEqual } from "../utils/objectUtils.js"
import {
	_encodeRelationalQuery,
	type AggregateQuery,
	type EncodedQuery,
} from "./Query.js"
import { matchesWhere } from "./executeQuery.js"

type Row = Record<string, unknown> & {
	id: string | number | readonly (string | number)[]
}
type Group = { keys: Record<string, unknown>; rows: Map<string, Row> }

function compareSerializedKeys(left: string, right: string): number {
	return left < right ? -1 : left > right ? 1 : 0
}

export function aggregateSource<Schema extends AnySchema>(query: {
	collection: CollectionName<Schema>
	where?: unknown
	groupBy?: readonly string[]
	aggregate: (rows: never) => unknown
	select?: unknown
	with?: unknown
	orderBy?: unknown
	limit?: unknown
	offset?: unknown
}): EncodedQuery<Schema> {
	if (
		query.select !== undefined ||
		query.with !== undefined ||
		query.orderBy !== undefined ||
		query.limit !== undefined ||
		query.offset !== undefined
	) {
		throw new Error(
			"Aggregate queries support only collection, where, groupBy, and aggregate",
		)
	}
	if (query.groupBy && new Set(query.groupBy).size !== query.groupBy.length) {
		throw new Error("Duplicate groupBy field")
	}
	return _encodeRelationalQuery(query.collection, {
		where: query.where,
	} as never)
}

export function subscribeAggregate<
	Schema extends AnySchema,
	Collection extends CollectionName<Schema>,
	Result,
>(
	db: TupleDatabaseClient<SchemaToTupleSchema<Schema>>,
	query: AggregateQuery<
		Schema,
		Collection,
		Result,
		readonly never[] | undefined
	>,
	callback: (result: unknown) => void,
) {
	const source = aggregateSource(query as never)
	const groupBy = query.groupBy as readonly string[] | undefined
	const members = new Map<string, { row: Row; groupId: string }>()
	const groups = new Map<string, Group>()
	const values = new Map<string, unknown>()
	const ungroupedId = "[]"
	const rowId = (row: Row) =>
		JSON.stringify(collectionIdToTuple(row.id as CollectionId))
	const groupFor = (row: Row) => {
		const entries = (groupBy ?? []).map((field) => [field, row[field]] as const)
		for (const [, value] of entries) {
			if (
				value !== undefined &&
				value !== null &&
				(!["string", "number", "boolean"].includes(typeof value) ||
					(typeof value === "number" && !Number.isFinite(value)))
			) {
				throw new Error("groupBy fields must have finite primitive values")
			}
		}
		return {
			id: groupBy
				? JSON.stringify(entries.map(([, value]) => [typeof value, value]))
				: ungroupedId,
			keys: Object.fromEntries(entries),
		}
	}
	const matches = (row: Row) =>
		(source.where ?? []).every((clause) => matchesWhere(row, clause))
	const setMember = (id: string, row: Row | undefined, dirty: Set<string>) => {
		const previous = members.get(id)
		if (previous && row && isEqual(previous.row, row) && matches(row)) return
		if (previous) {
			groups.get(previous.groupId)?.rows.delete(id)
			members.delete(id)
			dirty.add(previous.groupId)
		}
		if (!row || !matches(row)) return
		const { id: groupId, keys } = groupFor(row)
		const group = groups.get(groupId) ?? { keys, rows: new Map<string, Row>() }
		group.rows.set(id, row)
		groups.set(groupId, group)
		members.set(id, { row, groupId })
		dirty.add(groupId)
	}
	const evaluate = (dirty: ReadonlySet<string>) => {
		for (const id of dirty) {
			const group = groups.get(id)
			if (!group || (groupBy && group.rows.size === 0)) {
				groups.delete(id)
				values.delete(id)
				continue
			}
			const rows = [...group.rows.values()].sort((a, b) =>
				compareSerializedKeys(rowId(a), rowId(b)),
			)
			const value = query.aggregate(rows as never)
			if (groupBy) {
				if (
					value === null ||
					typeof value !== "object" ||
					Array.isArray(value)
				) {
					throw new Error("Grouped aggregate callbacks must return an object")
				}
				for (const key of groupBy) {
					if (Object.hasOwn(value, key))
						throw new Error(
							`Aggregate result conflicts with group key "${key}"`,
						)
				}
				values.set(id, { ...group.keys, ...value })
			} else values.set(id, value)
		}
		return groupBy
			? [...values]
					.sort(([left], [right]) => compareSerializedKeys(left, right))
					.map(([, value]) => value)
			: values.get(ungroupedId)
	}
	if (!groupBy) groups.set(ungroupedId, { keys: {}, rows: new Map() })
	const initial = db.scan({ prefix: ["record", query.collection] } as never)
	const dirty = new Set<string>(groupBy ? [] : [ungroupedId])
	for (const { value } of initial)
		setMember(rowId(value as Row), value as Row, dirty)
	let result = evaluate(dirty)
	const destroy = db.subscribe(
		{ prefix: ["record", query.collection] } as never,
		(writes) => {
			const changed = new Set<string>()
			for (const { key } of writes.set ?? [])
				changed.add(JSON.stringify(key.slice(2)))
			for (const key of writes.remove ?? [])
				changed.add(JSON.stringify(key.slice(2)))
			const dirty = new Set<string>()
			for (const id of changed) {
				const key = [
					"record",
					query.collection,
					...JSON.parse(id),
				] as unknown as SchemaToTupleSchema<Schema>["key"]
				setMember(id, db.get(key) as Row | undefined, dirty)
			}
			if (dirty.size === 0) return
			const next = evaluate(dirty)
			if (!isEqual(result, next)) {
				result = next
				callback(next)
			}
		},
	)
	const refresh = () => {
		const next = evaluate(new Set(groups.keys()))
		if (!isEqual(result, next)) {
			result = next
			callback(next)
		}
	}
	return { result, destroy, refresh }
}
