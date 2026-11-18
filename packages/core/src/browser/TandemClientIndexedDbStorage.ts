import { openDB } from "idb"
import type { DBSchema, IDBPDatabase } from "idb"
import type { ScanStorageArgs, WriteOps } from "tuple-database"
import { decodeTuple, encodeTuple } from "tuple-database/helpers/codec.js"
import type { AnySchema, RuntimeSchemaDefinition } from "../schema/Schema.js"
import {
	getSchemaCodecs,
	type CollectionCodecs,
} from "../schema/collectionCodecs.js"
import {
	transformClientTupleValue,
	type AnyStorageSchema,
} from "../clientStorage/clientTupleValues.js"
import type {
	TandemClientStorageApi,
	TandemClientTuple,
} from "../clientStorage/TandemClientStorage.js"
import { codec, type Codec, type PartialObjectCodec } from "../utils/Codec.js"
import type { Json } from "../utils/typeUtils.js"

const version = 1

const storeName = "tupledb"

interface TandemIndexedDbSchema extends DBSchema {
	tupledb: {
		key: string
		value: unknown
	}
}

export type TandemClientIndexedDbStorageArgs<
	Schema extends AnySchema,
	StorageSchema extends AnyStorageSchema<Schema> = AnyStorageSchema<Schema>,
> = {
	dbName: string
	schema?: RuntimeSchemaDefinition<Schema>
	codecs?: {
		[K in keyof Schema]?: PartialObjectCodec<Schema[K], StorageSchema[K]>
	}
}

function createTupleCodec<Schema extends AnySchema>(
	codecs: Record<string, Codec<unknown, unknown> | undefined>,
): Codec<TandemClientTuple<Schema>, { key: string; value: unknown }> {
	return codec(
		"TandemClientTuple",
		(input) => {
			const tuple = input as TandemClientTuple<Schema>
			return {
				key: encodeTuple(tuple.key),
				value: transformClientTupleValue(codecs, tuple, "encode"),
			}
		},
		(input) => {
			const encoded = input as { key: string; value: unknown }
			const tuple = {
				key: decodeTuple(encoded.key),
				value: encoded.value,
			} as TandemClientTuple<Schema>
			return {
				key: tuple.key,
				value: transformClientTupleValue(codecs, tuple, "decode"),
			} as TandemClientTuple<Schema>
		},
	)
}

export class TandemClientIndexedDbStorage<
	Schema extends AnySchema,
	StorageSchema extends {
		[K in keyof Schema]?: Json
	} = Schema,
> implements TandemClientStorageApi<Schema> {
	readonly codecs: CollectionCodecs<Schema>
	private connection?: Promise<IDBPDatabase<TandemIndexedDbSchema>>
	private readonly tupleCodec: Codec<
		TandemClientTuple<Schema>,
		{ key: string; value: unknown }
	>
	private dbName: string

	get name() {
		return this.dbName
	}

	constructor({
		dbName,
		schema,
		codecs,
	}: TandemClientIndexedDbStorageArgs<Schema, StorageSchema>) {
		this.codecs = {
			...getSchemaCodecs(schema),
			...codecs,
		}
		this.tupleCodec = createTupleCodec<Schema>(this.codecs)
		this.dbName = dbName
	}

	// Opens on first use: a tab that never leads never holds a connection.
	private get db() {
		this.connection ??= openDB<TandemIndexedDbSchema>(this.dbName, version, {
			upgrade(db) {
				db.createObjectStore(storeName)
			},
		})
		return this.connection
	}

	async scan(args?: ScanStorageArgs) {
		const db = await this.db
		const tx = db.transaction(storeName, "readonly")
		const index = tx.store // primary key

		const lower = args?.gt || args?.gte
		const lowerEq = Boolean(args?.gte)

		const upper = args?.lt || args?.lte
		const upperEq = Boolean(args?.lte)

		let range: IDBKeyRange | null
		if (upper) {
			if (lower) {
				range = IDBKeyRange.bound(
					encodeTuple(lower),
					encodeTuple(upper),
					!lowerEq,
					!upperEq,
				)
			} else {
				range = IDBKeyRange.upperBound(encodeTuple(upper), !upperEq)
			}
		} else {
			if (lower) {
				range = IDBKeyRange.lowerBound(encodeTuple(lower), !lowerEq)
			} else {
				range = null
			}
		}

		const direction = args?.reverse ? "prev" : "next"

		const limit = args?.limit || Infinity
		const results: TandemClientTuple<Schema>[] = []
		for await (const cursor of index.iterate(range, direction)) {
			results.push(
				this.tupleCodec.decode({ key: cursor.key, value: cursor.value }),
			)
			if (results.length >= limit) break
		}
		await tx.done

		return results
	}

	async commit(writes: WriteOps<TandemClientTuple<Schema>>) {
		// Finish codec work before opening a transaction so an encoding failure cannot persist a prefix.
		const set = (writes.set ?? []).map((tuple) => this.tupleCodec.encode(tuple))
		const remove = (writes.remove ?? []).map((key) => encodeTuple(key))
		const db = await this.db
		const tx = db.transaction(storeName, "readwrite")
		for (const { key, value } of set) {
			await tx.store.put(value, key)
		}
		for (const key of remove) {
			await tx.store.delete(key)
		}
		await tx.done
	}

	async close() {
		const connection = this.connection
		this.connection = undefined
		;(await connection)?.close()
	}

	async clear() {
		// Deleting the database would wait for every other tab to close its connection.
		const db = await this.db
		await db.clear(storeName)
	}
}
