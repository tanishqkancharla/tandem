# ✅ Phase 3: In-memory client storage

[Phase 2](02-idb-subpath.md) left IndexedDB storage as the only client storage that keeps data. This phase adds one that runs everywhere and moves core tests onto it, so they stop needing an IndexedDB global.

**Today**

A Node, server-rendering, or Workers app that wants client storage has to write its own `TandemClientStorageApi` implementation, as `dst/DstWorld.ts` does.

Core's `makeStorage` fixture always builds IndexedDB storage, and the first line of `test/fixtures.ts` installs `fake-indexeddb` for every test. A runtime dependency on IndexedDB in shared code therefore passes every test.

**Proposed**

The main entry exports `TandemClientMemoryStorage`. Storages with the same `name` share one store for the life of the process, so a client recreated with that name restores its records and pending writes:

```ts
import { TandemClientMemoryStorage } from "@tanishqkancharla/tandem-core"

const client = new TandemClient({
	schema,
	remote,
	clientStorage: new TandemClientMemoryStorage({ name: "tasks", schema }),
})
```

The `name` is only a key for sharing. The storage does not expose it as `TandemClientStorageApi.name`, so it never turns on tab coordination: browser tabs do not share memory.

Like IndexedDB storage, it applies collection codecs, and it copies values with `structuredClone` on the way in and out, so class instances survive only through their codec. Both adapters now share the codec logic, moved out of the IndexedDB file into [[11d1274:packages/core/src/clientStorage/clientTupleValues.ts#L19-L79]]:

```ts [TandemClientMemoryStorage]
const namedStores = new Map<string, InMemoryTupleStorage>()

export class TandemClientMemoryStorage<Schema, StorageSchema> {
	readonly codecs: CollectionCodecs<Schema>
	private readonly tuples: InMemoryTupleStorage // shared when named

	scan(args) {
		return Promise.resolve().then(() =>
			this.tuples.scan(args).map(({ key, value }) => ({
				key,
				value: transformClientTupleValue(codecs, { key, value: structuredClone(value) }, "decode"),
			})),
		)
	}

	commit(writes) {
		return Promise.resolve().then(() => {
			const set = writes.set.map((tuple) => ({
				key: tuple.key,
				value: structuredClone(transformClientTupleValue(codecs, tuple, "encode")),
			}))
			this.tuples.commit({ set, remove: writes.remove })
		})
	}
	// ...close and clear
}
// [!note L9-L16] Every method settles on a later microtask, and a codec error rejects instead of throwing, as with a real store.
// [!note L20-L25] Encoding the whole batch before committing means a codec failure cannot store part of it.
```

The full class is [[11d1274:packages/core/src/clientStorage/TandemClientMemoryStorage.ts#L21-L114]].

The `makeStorage` fixture builds memory storage, and only the IndexedDB spec installs the polyfill, for its own file:

```callstack [Core test storage]
 storage = makeStorage(options) [[11d1274:packages/core/test/fixtures.ts#L299-L319]]
-├── storage = new TandemClientIndexedDbStorage({ dbName }) # needs fake-indexeddb installed globally
+├── storage = new TandemClientMemoryStorage({ name: dbName, schema, codecs })
 └── return storage # cleared after the test
+describeClientStorageContract("TandemClientMemoryStorage", open) [[11d1274:packages/core/test/memory-storage.spec.ts]]
+describeClientStorageContract("TandemClientIndexedDbStorage", open) [[11d1274:packages/core/test/idb-storage.spec.ts]]
+├── beforeAll: install every fake-indexeddb global
+└── afterAll: delete them again
```

The client storage contract in [[11d1274:packages/core/test/clientStorageContract.ts#L31-L257]] is a shared suite of the behavior every adapter must keep:
- scans in key order with bounds, limits, and direction, and clearing;
- round-tripping replica metadata, sparse bases, and ordered outbox operations through codecs, after reopening with the same name;
- storing nothing from a batch whose codec fails.

The last two tests moved from `persistence.spec.ts`, so they now run against both adapters instead of once. The event schema they share with persistence tests moved to `test/testsEvents.ts`.

```ts
export type OpenStorage = <Schema extends AnySchema>(
	options: MakeStorageOptions<Schema> & { dbName: string },
) => TandemClientStorageApi<Schema>

export function describeClientStorageContract(adapter: string, open: OpenStorage): void
```

With no shared fixture installing `fake-indexeddb`, a core test that reaches IndexedDB without asking for it fails with `indexedDB is not defined`.

```changes
11d1274
packages/core/src/clientStorage/TandemClientMemoryStorage.ts
packages/core/src/clientStorage/clientTupleValues.ts
packages/core/src/clientStorage/TandemClientIndexedDbStorage.ts
packages/core/test/clientStorageContract.ts
packages/core/test/idb-storage.spec.ts
packages/core/test/memory-storage.spec.ts
packages/core/test/fixtures.ts
packages/core/test/tabs.spec.ts
docs/client.md

ignore:
packages/core/README.md
packages/core/src/clientStorage/AGENTS.md
packages/core/src/index.ts
packages/core/test/persistence.spec.ts
packages/core/test/testsEvents.ts
```
