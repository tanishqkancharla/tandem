/// <reference lib="dom" />

import { deleteDB, openDB } from "idb"
import type { DBSchema, IDBPDatabase } from "idb"
import type { ScanStorageArgs, WriteOps } from "tuple-database"
import { decodeTuple, encodeTuple } from "tuple-database/helpers/codec"
import type {
	AnySchema,
	RuntimeSchemaDefinition,
	SchemaToTupleSchema,
} from "../schema/Schema"
import type { TandemClientStorageApi } from "./TandemClientStorage"
import { Codec } from "../utils/Codec"
import type { Json } from "../utils/typeUtils"

const version = 1

const storeName = "tupledb"

interface TandemIndexedDbSchema extends DBSchema {
	tupledb: {
		key: string
		value: unknown
	}
}

export type AnyStorageSchema<Schema extends AnySchema> = {
	[K in keyof Schema]?: Json
}

export type TandemClientIndexedDbStorageArgs<
	Schema extends AnySchema,
	StorageSchema extends AnyStorageSchema<Schema> = AnyStorageSchema<Schema>,
> = {
	dbName: string
	schema?: RuntimeSchemaDefinition<Schema>
	codecs?: {
		[K in keyof Schema]?: Codec<Schema[K], StorageSchema[K]>
	}
}

function getSchemaCodecs<
	Schema extends AnySchema,
	StorageSchema extends AnyStorageSchema<Schema>,
>(
	schema?: RuntimeSchemaDefinition<Schema>,
):
	| {
			[K in keyof Schema]?: Codec<Schema[K], StorageSchema[K]>
	  }
	| undefined {
	if (!schema) return undefined

	return Object.fromEntries(
		Object.entries(schema.collections)
			.filter(([, collection]) => collection.codec)
			.map(([name, collection]) => [name, collection.codec]),
	) as {
		[K in keyof Schema]?: Codec<Schema[K], StorageSchema[K]>
	}
}

export class TandemClientIndexedDbStorage<
	Schema extends AnySchema,
	StorageSchema extends {
		[K in keyof Schema]?: Json
	} = Schema,
> implements TandemClientStorageApi<Schema> {
	private db: Promise<IDBPDatabase<TandemIndexedDbSchema>>
	private codecs?: {
		[K in keyof Schema]?: Codec<Schema[K], StorageSchema[K]>
	}
	private dbName: string

	constructor({
		dbName,
		schema,
		codecs,
	}: TandemClientIndexedDbStorageArgs<Schema, StorageSchema>) {
		this.codecs = {
			...getSchemaCodecs(schema),
			...codecs,
		} as {
			[K in keyof Schema]?: Codec<Schema[K], StorageSchema[K]>
		}
		this.dbName = dbName
		this.db = openDB<TandemIndexedDbSchema>(dbName, version, {
			upgrade(db) {
				db.createObjectStore(storeName)
			},
		})
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
		const results: SchemaToTupleSchema<Schema>[] = []
		for await (const cursor of index.iterate(range, direction)) {
			const key = decodeTuple(cursor.key)
			const recordType = key[1] as keyof Schema & string
			const codec = this.codecs?.[recordType]
			const value = codec ? codec.decode(cursor.value) : cursor.value

			// IndexedDB and the tuple codec return untyped serialized data. The
			// adapter is the boundary that restores the configured schema type.
			results.push({ key, value } as SchemaToTupleSchema<Schema>)
			if (results.length >= limit) break
		}
		await tx.done

		return results
	}

	async commit(writes: WriteOps<SchemaToTupleSchema<Schema>>) {
		const db = await this.db
		const tx = db.transaction(storeName, "readwrite")
		for (const { key, value } of writes.set || []) {
			const recordType = key[1] as keyof Schema & string
			const codec = this.codecs?.[recordType]
			const encodedValue = codec ? codec.encode(value) : value
			await tx.store.put(encodedValue, encodeTuple(key))
		}
		for (const key of writes.remove || []) {
			await tx.store.delete(encodeTuple(key))
		}
		await tx.done
	}

	async close() {
		const db = await this.db
		db.close()
	}

	async clear() {
		const db = await this.db
		db.close()

		// Delete the database using idb's deleteDB
		await deleteDB(this.dbName)

		// Recreate the database
		this.db = openDB<TandemIndexedDbSchema>(this.dbName, version, {
			upgrade(db) {
				db.createObjectStore(storeName)
			},
		})
	}
}
