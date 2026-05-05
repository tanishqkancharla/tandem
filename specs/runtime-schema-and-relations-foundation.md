## Problem overview

Relational Queries v2 needs runtime collection and relation metadata, but Tandem currently only knows the schema at the type level. The current query, sync, and storage layers operate on flat collection names, which means later relational work has no stable runtime foundation to build on.

## Solution overview

Add an optional runtime schema API built around `collection(...)`, `defineSchema(...)`, and `defineRelations(...)`. This spec stops at defining, validating, and threading that metadata through the client, database, and storage layers while keeping today's flat query and sync behavior unchanged.

## Goals

- App authors can define runtime collection metadata in one place instead of relying only on TypeScript generics.
- App authors can define `one` and `many` relations that Tandem validates eagerly at startup.
- Collection-owned codecs can live on the runtime schema and be consumed by persistence code.
- Existing flat `run(...)`, `subscribe(...)`, transactions, and sync flows continue to behave the same with or without a runtime schema.

## Non-goals

- No migrations or backfills.
- No relational query execution in `run(...)`.
- No relational `subscribe(...)` behavior or relation-aware scan-window invalidation.
- No remote protocol, patch shape, or server behavior changes.
- No rewrite of the current builder API.
- No many-to-many, through, polymorphic, or non-`id` relation targets.

## Future work

- Reserved for follow-up items discovered during implementation.

## Important files/docs/websites for implementation

- `packages/types/src/types.ts` - Core public types. This is the likely home for runtime schema and normalized relation metadata types.
- `packages/core/src/TandemClient.ts` - Public client constructor. It needs to accept the optional runtime schema without changing current behavior.
- `packages/core/src/Database.ts` - Current flat query executor. It should hold runtime schema metadata for later specs but must not change query semantics in this spec.
- `packages/core/src/storage/IndexedDbAdapter.ts` - Current consumer of per-collection codecs. This is the first concrete place to make schema-owned codecs useful.
- `packages/core/src/utils/Codec.ts` - Existing codec primitives that the new schema API should reuse instead of inventing a second codec system.
- `packages/core/src/query/Query.ts` - Current builder-based query API. It should remain the active query surface after this spec lands.
- `packages/core/src/sync/SyncEngine.ts` - Sync still tracks only flat scan windows in this spec; this file is the main regression surface.
- `packages/testing/src/TestRemote.ts` - Test remote still intersects subscriptions by root collection only; spec 1 must leave that behavior alone.
- `packages/core/test/TandemClient.spec.ts` - Regression coverage for flat reads, subscriptions, persistence, and sync.
- `README.md` - Current roadmap notes already call out relational queries and codec/runtime schema work.
- `https://www.notion.so/Relational-tandem-258ac9fb35f1801e88eaf858b5401317` - Product direction for relational queries, runtime schemas, codec ownership, and relation metadata.

## Implementation

### Phase 1: Add runtime collection and schema primitives

Introduce the smallest public runtime schema surface first so later phases can attach relations and codecs to a real object. This phase should be additive: existing type-only clients keep working exactly as they do today.

```ts
const todos = collection<Todo>()

const users = collection({
	id: t.id(),
	name: t.string(),
})

const appSchema = defineSchema({
	users,
	todos,
})
```

- [x] Add runtime types for collection definitions and schema definitions in `packages/types/src/types.ts`
- [x] Add public `collection(...)` and `defineSchema(...)` helpers in a new schema-focused module and export them from `packages/core/src/index.ts`
- [x] Add field builders like `t.id()` and `t.string()` so runtime collection shapes can carry record field metadata
- [x] Reuse the existing codec type from `packages/core/src/utils/Codec.ts` so collection metadata can optionally carry a codec
- [x] Keep `TandemClient<Schema>` construction without a runtime schema fully supported
- [x] Verify `npm run tsc` passes after the new public API is exported
- [x] Skip a dedicated runtime metadata unit test; it only asserted internal object shape, while the public API is covered by type-checking and later behavior tests

### Phase 2: Add relation registration, normalization, and fail-fast validation

Layer relation metadata on top of the runtime schema, but keep it declarative only. By the end of this phase, Tandem can describe relations precisely and reject invalid configs before any query work starts.
Runtime field definitions supplied through `collection({ id: t.id(), name: t.string() })` are used as the startup-time source of truth for validating relation join fields and relation-name collisions.

```ts
const appSchema = defineSchema({
	users: collection({
		id: t.id(),
		name: t.string(),
	}),
	posts: collection({
		id: t.id(),
		authorId: t.string(),
		title: t.string(),
	}),
})

const relationalSchema = defineRelations(appSchema, ({ one, many }) => ({
	posts: {
		author: one("users", { from: "authorId", to: "id" }),
	},
	users: {
		posts: many("posts", { from: "id", to: "authorId" }),
	},
}))
```

- [x] Add normalized runtime relation types for `one` and `many`
- [x] Add `defineRelations(...)` that augments a runtime schema with relation metadata
- [x] Validate unknown target collections, missing source fields, duplicate relation names, and relation-name collisions with record fields
- [x] Restrict this first version to joins targeting the related record `id`
- [x] Add tests for one valid `one` relation and one valid `many` relation
- [x] Add tests that invalid relation definitions throw descriptive startup-time errors instead of failing later during query execution

### Phase 3: Thread runtime schema through the client and database without changing behavior

Make the new metadata available everywhere later specs will need it, but do not consume it for relational reads yet. The codebase should still behave like a flat-query engine after this phase lands.

```ts
const client = new TandemClient<AppSchema>({
	schema: relationalSchema,
	remote,
	storage,
})
```

- [ ] Add optional `schema` support to `TandemClient` constructor args
- [ ] Thread the schema into `Database` and any internal helpers that will need it later
- [ ] Keep `QueryBuilder`, `EncodedQuery`, `Database.runQuery(...)`, `SyncEngine`, and `TestRemote` behavior unchanged in this spec
- [ ] Add a regression test that a schema-enabled client still supports today's flat `run(...)` queries unchanged
- [ ] Add a regression test that a schema-enabled synced client still receives flat subscription updates unchanged
- [ ] Run `npm run test -- packages/core/test/TandemClient.spec.ts` and confirm existing flat-query and sync coverage still passes

### Phase 4: Let IndexedDB storage read codecs from the runtime schema

Use the new schema for one concrete behavior change: making collection codecs a schema concern instead of a separate parallel map. This keeps the spec grounded in a real end-to-end use case without pulling in relational query execution.

```ts
const events = collection(
	{
		id: t.id(),
		startAt: t.string(),
	},
	{ codec: codec("event", encodeEvent, decodeEvent) },
)

const schema = defineSchema({ events })
const storage = new IndexedDbTupleStorage({ dbName: "app", schema })
```

- [ ] Add an optional `schema` argument to `IndexedDbTupleStorage`
- [ ] Derive per-collection codecs from the runtime schema when available
- [ ] Preserve the existing explicit `codecs` option during this spec so current callers do not break
- [ ] Add a persistence round-trip test that stores a record through a schema-owned codec and reads the decoded value back after recreating storage/client
- [ ] Verify `npm run test -- packages/core/test/TandemClient.spec.ts` and any new schema/storage test file both pass
- [ ] Add a short README note showing that runtime schema is foundation work only; relational object-style queries remain deferred to later specs
