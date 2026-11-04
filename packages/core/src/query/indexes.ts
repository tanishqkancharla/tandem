import type {
	AsyncTupleDatabaseApi,
	KeyValuePair,
	ScanStorageArgs,
	TupleDatabaseApi,
	TxId,
	WriteOps,
} from "tuple-database"
import type {
	AnySchema,
	CollectionIdPart,
	RuntimeSchemaDefinition,
} from "../schema/Schema.js"

/** A value an index key holds for one field. */
export type IndexValue = string | number | boolean | null

/**
 * One index entry: the indexed field values, then the record ID. Entries sort
 * by those values, so a range scan finds candidates in order.
 */
export type TandemIndexTuple = {
	key: [
		"index",
		collection: string,
		index: string,
		...valuesThenId: (IndexValue | CollectionIdPart)[],
	]
	value: null
}

/** Which index definitions the stored entries were built for. */
export type TandemIndexMetadataTuple = {
	key: ["indexes"]
	value: { definitions: string }
}

export type IndexDefinition = {
	collection: string
	name: string
	fields: readonly string[]
}

/** The schema's index definitions, by collection. */
export type SchemaIndexes = ReadonlyMap<string, readonly IndexDefinition[]>

export function schemaIndexes<Schema extends AnySchema>(
	schema: RuntimeSchemaDefinition<Schema> | undefined,
): SchemaIndexes {
	const indexes = new Map<string, IndexDefinition[]>()
	for (const [collection, definition] of Object.entries(
		schema?.collections ?? {},
	)) {
		const declared: [string, readonly string[]][] = Object.entries(
			definition.indexes ?? {},
		)
		if (!declared.length) continue
		const known = definition.fields && new Set<string>(definition.fields)
		indexes.set(
			collection,
			declared.map(([name, fields]) => {
				if (!fields.length)
					throw new Error(`Index "${collection}.${name}" needs a field`)
				const unknown = fields.find((field) => known && !known.has(field))
				if (unknown !== undefined)
					throw new Error(
						`Index "${collection}.${name}" names unknown field "${unknown}"`,
					)
				return { collection, name, fields }
			}),
		)
	}
	return indexes
}

/** A stable description of the definitions, saved beside server entries. */
export function indexDefinitionsSignature(indexes: SchemaIndexes): string {
	return JSON.stringify(
		[...indexes.values()]
			.flat()
			.map(({ collection, name, fields }) => [collection, name, fields])
			.sort((left, right) =>
				JSON.stringify(left) < JSON.stringify(right) ? -1 : 1,
			),
	)
}

/**
 * The key value for one field. Strings, finite numbers, and booleans keep
 * their own order; every other value, including a missing field, is `null`,
 * which sorts first. Queries read such entries only through checks that
 * do not depend on their order.
 */
export function indexValue(value: unknown): IndexValue {
	if (typeof value === "string" || typeof value === "boolean") return value
	if (typeof value === "number" && Number.isFinite(value))
		return Object.is(value, -0) ? 0 : value
	return null
}

export function indexKey(
	index: IndexDefinition,
	record: Record<string, unknown>,
	id: readonly CollectionIdPart[],
): TandemIndexTuple["key"] {
	return [
		"index",
		index.collection,
		index.name,
		...index.fields.map((field) => indexValue(record[field])),
		...id,
	]
}

type RecordKey = readonly ["record", string, ...CollectionIdPart[]]

function isRecordKey(key: readonly unknown[]): key is RecordKey {
	return key[0] === "record" && typeof key[1] === "string"
}

/**
 * The index writes that keep entries in step with record writes. `previous`
 * holds each written record's value before the commit.
 */
function indexWrites(
	indexes: SchemaIndexes,
	writes: WriteOps,
	previous: ReadonlyMap<string, unknown>,
): WriteOps {
	const set: KeyValuePair[] = []
	const remove: KeyValuePair["key"][] = []
	const update = (key: RecordKey, next: unknown) => {
		const id = key.slice(2) as CollectionIdPart[]
		const before = previous.get(JSON.stringify(key)) as
			| Record<string, unknown>
			| undefined
		for (const index of indexes.get(key[1]) ?? []) {
			const old = before && indexKey(index, before, id)
			const fresh =
				next === undefined
					? undefined
					: indexKey(index, next as Record<string, unknown>, id)
			if (old && fresh && JSON.stringify(old) === JSON.stringify(fresh))
				continue
			if (old) remove.push(old)
			if (fresh) set.push({ key: fresh, value: null })
		}
	}
	for (const key of writes.remove ?? [])
		if (isRecordKey(key)) update(key, undefined)
	for (const { key, value } of writes.set ?? [])
		if (isRecordKey(key)) update(key, value)
	return { set, remove }
}

/** Record keys in `writes` whose collection has indexes. */
function indexedRecordKeys(indexes: SchemaIndexes, writes: WriteOps) {
	const keys: RecordKey[] = []
	for (const key of [
		...(writes.remove ?? []),
		...(writes.set ?? []).map(({ key }) => key),
	])
		if (isRecordKey(key) && indexes.has(key[1])) keys.push(key)
	return keys
}

function withIndexWrites(writes: WriteOps, index: WriteOps): WriteOps {
	return {
		set: [...(writes.set ?? []), ...(index.set ?? [])],
		remove: [...(writes.remove ?? []), ...(index.remove ?? [])],
	}
}

/**
 * Writes index entries in the same commit as the records they describe, so
 * every transaction, pull, replay, and hydration keeps them in step.
 */
export class TupleDatabaseWithIndexes implements TupleDatabaseApi {
	private readonly database: TupleDatabaseApi
	private readonly indexes: SchemaIndexes

	constructor({
		database,
		indexes,
	}: {
		database: TupleDatabaseApi
		indexes: SchemaIndexes
	}) {
		this.database = database
		this.indexes = indexes
	}

	scan(args?: ScanStorageArgs, txId?: TxId) {
		return this.database.scan(args, txId)
	}

	commit(writes: WriteOps, txId?: TxId) {
		const keys = indexedRecordKeys(this.indexes, writes)
		if (!keys.length) return this.database.commit(writes, txId)
		const previous = new Map(
			keys.map((key) => [
				JSON.stringify(key),
				this.database.scan({ gte: [...key], lte: [...key] })[0]?.value,
			]),
		)
		return this.database.commit(
			withIndexWrites(writes, indexWrites(this.indexes, writes, previous)),
			txId,
		)
	}

	cancel(txId: string) {
		return this.database.cancel(txId)
	}

	subscribe(...args: Parameters<TupleDatabaseApi["subscribe"]>) {
		return this.database.subscribe(...args)
	}

	close() {
		return this.database.close()
	}
}

/** The asynchronous form, for server storage. */
export class AsyncTupleDatabaseWithIndexes implements AsyncTupleDatabaseApi {
	private readonly database: AsyncTupleDatabaseApi
	private readonly indexes: SchemaIndexes

	constructor({
		database,
		indexes,
	}: {
		database: AsyncTupleDatabaseApi
		indexes: SchemaIndexes
	}) {
		this.database = database
		this.indexes = indexes
	}

	scan(args?: ScanStorageArgs, txId?: TxId) {
		return this.database.scan(args, txId)
	}

	async commit(writes: WriteOps, txId?: TxId) {
		const keys = indexedRecordKeys(this.indexes, writes)
		if (!keys.length) return this.database.commit(writes, txId)
		const previous = new Map(
			await Promise.all(
				keys.map(
					async (key) =>
						[
							JSON.stringify(key),
							(await this.database.scan({ gte: [...key], lte: [...key] }))[0]
								?.value,
						] as const,
				),
			),
		)
		return this.database.commit(
			withIndexWrites(writes, indexWrites(this.indexes, writes, previous)),
			txId,
		)
	}

	cancel(txId: string) {
		return this.database.cancel(txId)
	}

	subscribe(...args: Parameters<AsyncTupleDatabaseApi["subscribe"]>) {
		return this.database.subscribe(...args)
	}

	close() {
		return this.database.close()
	}
}

/**
 * Index writes that rebuild every entry from `records`: removals for the
 * stored entries, the entries the records need, and the definitions.
 */
export function rebuildIndexWrites(
	indexes: SchemaIndexes,
	stored: readonly KeyValuePair["key"][],
	records: readonly { key: readonly unknown[]; value: unknown }[],
): WriteOps {
	const set: KeyValuePair[] = [
		{
			key: ["indexes"],
			value: { definitions: indexDefinitionsSignature(indexes) },
		},
	]
	for (const { key, value } of records) {
		if (!isRecordKey(key)) continue
		for (const index of indexes.get(key[1]) ?? [])
			set.push({
				key: indexKey(
					index,
					value as Record<string, unknown>,
					key.slice(2) as CollectionIdPart[],
				),
				value: null,
			})
	}
	const kept = new Set(set.map(({ key }) => JSON.stringify(key)))
	return {
		set,
		remove: stored.filter((key) => !kept.has(JSON.stringify(key))),
	}
}
