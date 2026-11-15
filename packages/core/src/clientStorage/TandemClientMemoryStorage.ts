import {
	InMemoryTupleStorage,
	type ScanStorageArgs,
	type WriteOps,
} from "tuple-database"
import type { AnySchema, RuntimeSchemaDefinition } from "../schema/Schema.js"
import {
	getSchemaCodecs,
	type CollectionCodecs,
} from "../schema/collectionCodecs.js"
import type { Codec, PartialObjectCodec } from "../utils/Codec.js"
import {
	transformClientTupleValue,
	type AnyStorageSchema,
} from "./clientTupleValues.js"
import type {
	TandemClientStorageApi,
	TandemClientTuple,
} from "./TandemClientStorage.js"

const namedStores = new Map<string, InMemoryTupleStorage>()

export type TandemClientMemoryStorageArgs<
	Schema extends AnySchema,
	StorageSchema extends AnyStorageSchema<Schema> = AnyStorageSchema<Schema>,
> = {
	/**
	 * Storages with the same name share their data for the life of the
	 * process. Leave it out for storage private to this instance. Unlike an
	 * IndexedDB name, it does not turn on tab coordination, because browser
	 * tabs do not share memory.
	 */
	name?: string
	schema?: RuntimeSchemaDefinition<Schema>
	codecs?: {
		[K in keyof Schema]?: PartialObjectCodec<Schema[K], StorageSchema[K]>
	}
}

/**
 * Client storage that keeps tuples in memory. It runs in any JavaScript
 * runtime. Values are encoded with collection codecs and copied with
 * `structuredClone` on the way in and out, as a persistent store would.
 */
export class TandemClientMemoryStorage<
	Schema extends AnySchema,
	StorageSchema extends AnyStorageSchema<Schema> = Schema,
> implements TandemClientStorageApi<Schema> {
	readonly codecs: CollectionCodecs<Schema>
	private readonly tuples: InMemoryTupleStorage

	constructor({
		name,
		schema,
		codecs,
	}: TandemClientMemoryStorageArgs<Schema, StorageSchema> = {}) {
		this.codecs = { ...getSchemaCodecs(schema), ...codecs }
		if (name === undefined) {
			this.tuples = new InMemoryTupleStorage()
		} else {
			const store = namedStores.get(name) ?? new InMemoryTupleStorage()
			namedStores.set(name, store)
			this.tuples = store
		}
	}

	private get valueCodecs() {
		return this.codecs as Record<string, Codec<unknown, unknown> | undefined>
	}

	// Each method settles on a later microtask, and a codec error rejects
	// rather than throws, as with a real store.
	scan(args?: ScanStorageArgs): Promise<TandemClientTuple<Schema>[]> {
		return Promise.resolve().then(() =>
			this.tuples.scan(args).map(
				({ key, value }) =>
					({
						key,
						value: transformClientTupleValue(
							this.valueCodecs,
							{
								key,
								value: structuredClone(value),
							} as TandemClientTuple<Schema>,
							"decode",
						),
					}) as TandemClientTuple<Schema>,
			),
		)
	}

	commit(writes: WriteOps<TandemClientTuple<Schema>>): Promise<void> {
		return Promise.resolve().then(() => {
			// Encode the whole batch first so a codec failure cannot persist a prefix.
			const set = (writes.set ?? []).map((tuple) => ({
				key: tuple.key,
				value: structuredClone(
					transformClientTupleValue(this.valueCodecs, tuple, "encode"),
				),
			}))
			this.tuples.commit({ set, remove: writes.remove ?? [] })
		})
	}

	close(): Promise<void> {
		return Promise.resolve()
	}

	clear(): Promise<void> {
		return Promise.resolve().then(() => {
			this.tuples.commit({ remove: this.tuples.scan().map(({ key }) => key) })
		})
	}
}
