# Type inference for relational queries

## Problem overview

Relational Queries v2 has a public object query shape, but the current public types still describe the old flat builder API and do not infer relation-aware results. Callers need `useQuery`/`run`/`subscribe` query options to be tied to schema and relation metadata so invalid fields or relations fail at compile time and selected results match the query.

## Solution overview

Add public TypeScript types for relational query options and result inference, driven by the runtime schema record type and a separate literal relation metadata object produced by `defineRelations`. Keep this phase type-only for querying: no query encoding, execution, subscription behavior, or remote sync changes.

## Goals

- Infer scalar result fields from `select`, with omitted `select` returning all scalar fields.
- Infer nested `with` results using the same query option shape scoped to each relation target collection.
- Preserve relation cardinality in result types: `many-to-one` relations are selected objects or `null`, and `one-to-many` relations are arrays.
- Reject invalid collection names, selected fields, `where` fields/value types, `orderBy` fields/directions, and relation names at compile time.
- Make `defineRelations` return first-class relation metadata, not a second schema object, while preserving literal relation names, target collections, and relation types strongly enough for nested inference.

## Non-goals

- No migrations or backfills.
- Do not implement relational query encoding or scan-window changes.
- Do not implement local execution, subscriptions, remote sync, scan windows, backend authorization, or runtime validation.
- Do not preserve compatibility with loose public query types such as `Record<string, any>`.

## Future work

- Encode the accepted object query shape into the scan-window/query transport format.
- Execute relational queries locally using schema relation metadata.
- Subscribe to relational queries and re-emit parent rows when included child records change.
- Sync relational subscriptions through the remote protocol with relation-aware scan windows.

## Important files/docs for implementation

- `docs/relational-queries-design.md` - Source of truth for the public object query shape and result semantics.
- `README.md` - Relational Queries v2 roadmap that links this spec.
- `packages/types/src/types.ts` - Shared schema, relation, query, and type-test helper exports; likely home for public query option/result types.
- `packages/types/src/utils/typeUtils.ts` - Existing `Assert`, `TestIsEqual`, and `TestExtends` compile-time assertion helpers.
- `packages/core/src/schema/Schema.ts` - `defineSchema`, `collection`, and `defineRelations`; `defineRelations` should return separate literal relation metadata instead of schema-with-relations.
- `packages/core/src/query/Query.ts` - Current flat builder and `QueryResults` type; future object query types should not depend on the fluent builder shape.
- `packages/core/src/TandemClient.ts` - Public `run`/`subscribe` surface that will later consume the object query option/result types.
- `packages/core/test/Schema.spec.ts` - Runtime relation metadata coverage; useful context, but this phase should primarily use compile-time type assertions.

## Implementation

### Phase 1: Split relation metadata from schema values

Change `defineRelations` to return a first-class relations object, following Drizzle's v2 shape conceptually: schema definitions stay as one schema value, and relation metadata is passed alongside the schema instead of producing a second schema-with-relations value. The returned relation metadata must still be the normalized runtime relation map, but its type must preserve each relation name, target collection, and `many-to-one`/`one-to-many` type from the caller's object literal.

```ts
const schema = defineSchema({
	users: collection({ id: t.id(), name: t.string() }),
	threads: collection({ id: t.id(), ownerId: t.string(), title: t.string() }),
	messages: collection({ id: t.id(), threadId: t.string(), body: t.string() }),
})

const relations = defineRelations(schema, ({ one, many }) => ({
	threads: {
		owner: one("users", { from: "ownerId", to: "id" }),
		messages: many("messages", { from: "id", to: "threadId" }),
	},
}))

new TandemClient({ schema, relations })
```

- [x] Add a separate `relations?: ...` option anywhere runtime schema relations are currently read from `schema.relations`, starting with `TandemClientArgs`/`Database` construction if needed for existing behavior.
- [x] Change `defineRelations(schema, define)` to return the normalized relation metadata object directly instead of `{ ...schema, relations }`.
- [x] Keep `defineSchema(...)` responsible only for collection definitions.
- [x] Update relation runtime tests to assert the new returned object shape, e.g. `relations.posts.author`, not `schema.relations.posts.author`.
- [x] Verify existing runtime relation validation behavior still throws the same descriptive startup errors.
- [x] Verify `pnpm --filter @tandem/core test` passes.

### Phase 2: Preserve literal relation metadata from `defineRelations`

Type the new standalone relation metadata so each relation keeps its literal `name`, `targetCollection`, and `type`. This gives query inference a precise relation map without coupling relations to a schema-returning helper.

```ts
const relations = defineRelations(schema, ({ one, many }) => ({
	threads: {
		owner: one("users", { from: "ownerId", to: "id" }),
		messages: many("messages", { from: "id", to: "threadId" }),
	},
}))

type OwnerTarget = typeof relations.threads.owner.targetCollection // "users"
type MessagesType = typeof relations.threads.messages.type // "one-to-many"
```

- [x] Introduce or adjust relation helper types so `typeof relations.threads.owner` preserves `name: "owner"`, `targetCollection: "users"`, and `type: "many-to-one"`.
- [x] Keep runtime normalization unchanged except for renaming relation `kind` to `type`: relation values still include `type`, `name`, `sourceCollection`, `targetCollection`, `from`, and `to`.
- [x] Add compile-time assertions that relation names and relation types are not widened to `string`/`RelationType`.
- [x] Verify `pnpm --filter @tandem/types type-check` and `pnpm --filter @tandem/core type-check` pass.

### Phase 3: Add schema-scoped relational query option types

Define public option types for the design-doc shape: `select`, `where`, `with`, `orderBy`, `limit`, and `offset`. Keys must be scalar fields or relation names scoped to the current collection, and nested `with` options must switch to the related target collection.

```ts
type RelationalQueryOptions<Schema, Relations, Collection> = {
	select?: { [Field in keyof Schema[Collection]]?: true }
	where?: {
		[Field in keyof Schema[Collection]]?:
			| Schema[Collection][Field]
			| FieldOps<Schema[Collection][Field]>
	}
	orderBy?: { [Field in keyof Schema[Collection]]?: "asc" | "desc" }
	with?: RelationalWithOptions<Schema, Relations, Collection>
	limit?: number
	offset?: number
}
```

- [x] Export a query-options type from the public types package that is parameterized by schema, relation metadata, and collection name.
- [x] Ensure root collection names are constrained to `CollectionName<Schema>`.
- [x] Ensure `select`, `where`, and `orderBy` only accept scalar fields on the current collection; relation names are only valid under `with`.
- [x] Ensure `where` equality shorthand values are assignable to the selected field type and operator objects support `eq`, `gt`, `lt`, `gte`, and `lte`.
- [x] Ensure `orderBy` values are only `"asc" | "desc"`.
- [x] Ensure nested `with` option objects are scoped to each relation's `targetCollection`.
- [x] Use `@ts-expect-error` type tests for invalid collection names, fields, value types, order directions, and relation names.

### Phase 4: Add selected scalar result inference

Infer row scalar fields from `select`: omitted `select` returns the whole collection record, while an inclusion map returns exactly the selected scalar fields. Only `true` values participate in inference; `false`, aliases, computed fields, and `"*"` are not part of the public object API.

```ts
type ThreadTitleRows = RelationalQueryResult<
	Schema,
	Relations,
	"threads",
	{ select: { id: true; title: true } }
>
// Array<{ id: string; title: string }>
```

- [x] Export a result type that takes schema, relation metadata, collection name, and query options.
- [x] Infer omitted `select` as `Schema[Collection]` scalar fields.
- [x] Infer explicit `select` as `Pick<Schema[Collection], SelectedKeys>`.
- [x] Reject non-`true` select values at compile time.
- [x] Add `Assert<TestIsEqual<...>>` coverage for omitted select, single-field select, and multi-field select.

### Phase 5: Add nested relation result inference and cardinality

Merge requested `with` keys into each parent row using the nested relation result type. A `many-to-one` relation returns the selected target object or `null`; a `one-to-many` relation returns an array of selected target objects, even when `limit: 1` is present.

```ts
type ThreadRows = RelationalQueryResult<
	Schema,
	Relations,
	"threads",
	{
		select: { id: true; title: true }
		with: {
			owner: { select: { name: true } }
			messages: { select: { body: true }; limit: 1 }
		}
	}
>
// Array<{ id: string; title: string; owner: { name: string } | null; messages: { body: string }[] }>
```

- [ ] Infer `with: { relation: true }` as all scalar fields from the target collection.
- [ ] Infer `with: { relation: { select, where, with, orderBy, limit, offset } }` recursively using the target collection.
- [ ] Preserve `many-to-one` cardinality as `NestedRow | null`.
- [ ] Preserve `one-to-many` cardinality as `NestedRow[]`, including when `limit: 1` is specified.
- [ ] Add nested `Assert<TestIsEqual<...>>` coverage for many-to-one relation, one-to-many relation, and at least one two-level nested `with` query.
- [ ] Add `@ts-expect-error` coverage for selecting target-collection fields from the wrong nested scope and for unknown nested relation names.

### Phase 6: Thread types through public client/query surfaces without changing runtime behavior

Expose the new public types from package entry points and, where possible without implementing object-query execution, prepare `TandemClient`/query exports so future `run`, `subscribe`, and React hooks can share the same option and result types. This phase should not make object-style relational queries executable yet.

```ts
type ThreadsQuery = RelationalQueryOptions<Schema, Relations, "threads">
type ThreadsResult = RelationalQueryResult<
	Schema,
	Relations,
	"threads",
	ThreadsQuery
>
```

- [ ] Re-export the public option/result types from `@tandem/types` and `@tandem/core` as appropriate.
- [ ] Avoid accepting object-style relational queries at runtime unless they intentionally throw or remain type-only; execution belongs to a later spec.
- [ ] Keep existing flat `QueryBuilder` behavior compiling while the object query API is phased in.
- [ ] Verify `pnpm type-check` passes.
- [ ] Verify existing `pnpm --filter @tandem/core test` passes.
