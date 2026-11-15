# Phase 3: In-memory client storage

[Phase 2](02-idb-subpath.md) left IndexedDB storage as the only persistent client storage. This phase adds one that runs everywhere and moves core tests onto it, so they stop needing an IndexedDB global.

**Today**

A Node, server-rendering, or Workers app that wants client storage has to write its own [[packages/core/src/clientStorage/TandemClientStorage.ts#TandemClientStorageApi]] implementation, as [[dst/DstWorld.ts#L255-L282]] does.

Core's `makeStorage` fixture in [[packages/core/test/fixtures.ts#L301-L330]] always builds IndexedDB storage, and the file's first line installs `fake-indexeddb` for every test. A runtime dependency on IndexedDB in shared code therefore passes every test.

**Proposed**

The main entry exports `TandemClientMemoryStorage`. A client that "restarts" reuses the same instance:

```ts
const storage = new TandemClientMemoryStorage({ schema })
const first = new TandemClient({ schema, remote, clientStorage: storage })
// ...commit, close...
const second = new TandemClient({ schema, remote, clientStorage: storage }) // restores records and pending writes
```

It holds tuples in a `tuple-database` `InMemoryTupleStorage` and copies values on the way in and out, the way a real store would:

```ts
export type TandemClientMemoryStorageArgs<Schema extends AnySchema> = {
	/** Lets tab sessions share this storage; see TandemClientStorageApi.name. */
	name?: string
	schema?: RuntimeSchemaDefinition<Schema>
}

export class TandemClientMemoryStorage<Schema extends AnySchema>
	implements TandemClientStorageApi<Schema>
{
	readonly name?: string
	readonly codecs: CollectionCodecs<Schema>
	private readonly tuples = new InMemoryTupleStorage()

	constructor({ name, schema }: TandemClientMemoryStorageArgs<Schema> = {}) {
		this.name = name
		this.codecs = getSchemaCodecs(schema)
	}

	async scan(args?: ScanStorageArgs) {
		return structuredClone(this.tuples.scan(args)) as TandemClientTuple<Schema>[]
	}

	async commit(writes: WriteOps<TandemClientTuple<Schema>>) {
		this.tuples.commit(structuredClone(writes))
	}

	async close() {}

	async clear() {
		this.tuples.commit({ remove: this.tuples.scan().map(({ key }) => key) })
	}
}
// [!note structuredClone] Callers cannot mutate stored values, and values that cannot be cloned fail here as they would in IndexedDB.
```

The fixture builds memory storage by default. IndexedDB moves to the one spec that tests the adapter itself, and only that spec imports the polyfill:

```callstack [Core test storage]
 storage = makeStorage(options) [[packages/core/test/fixtures.ts#L301-L330]]
-├── storage = new TandemClientIndexedDbStorage({ dbName }) # needs fake-indexeddb installed globally
+├── storage = new TandemClientMemoryStorage({ name, schema })
 └── return storage # closed and cleared after the test
+describeClientStorageContract("IndexedDB", makeIdbStorage) # test/idb-storage.spec.ts imports fake-indexeddb/auto
+describeClientStorageContract("memory", makeMemoryStorage)
```

The client storage contract is a shared suite of the behavior every adapter must keep:
- atomic batches;
- ordered scans with bounds, limits, and reverse;
- codecs applied to records, bases, and the outbox;
- clear;
- a restart that restores identity and pending writes.

[[packages/server/test/TandemServerStorage.fixture.ts]] plays the same part for server storage.

```ts
export function describeClientStorageContract(
	name: string,
	makeStorage: <Schema extends AnySchema>(args: {
		name: string
		schema?: RuntimeSchemaDefinition<Schema>
	}) => TandemClientStorageApi<Schema>,
): void
```

Once no shared fixture imports `fake-indexeddb/auto`, a core test that reaches IndexedDB without asking for it fails with `indexedDB is not defined`.

```changes

```
