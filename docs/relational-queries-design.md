# Relational queries design

## Overview

Relational Queries v2 makes Tandem queries schema-aware and relation-aware while keeping the public API small. Runtime schemas, schema-owned codecs, and basic `defineRelations` metadata already exist; this design defines the target query shape that later type inference, encoding, execution, subscription, and sync specs should implement.

The public query shape is a single serializable object with an explicit `collection` field:

```ts
const threads = useQuery({
	collection: "threads",
	select: { id: true, title: true, status: true, updatedAt: true },
	where: { status: "active" },
	with: {
		messages: {
			select: { id: true, body: true, createdAt: true },
			orderBy: { createdAt: "desc" },
			limit: 1,
		},
	},
	orderBy: { updatedAt: "desc" },
	limit: 50,
	offset: 0,
})
```

The same query object should be canonical outside React:

```ts
const threads = client.query(query)
const subscription = client.subscribe(query, callback)
```

Only `collection` is required; omitted options are equivalent to `{}`.

## Design goals

- Query a collection with `useQuery({ collection: "collection", select, where, with, orderBy, limit, offset })`.
- Include `many-to-one` and `one-to-many` relations through `with` using the same nested options shape as the root query.
- Keep the public query shape JSON-serializable so it can be encoded for scan windows and remote sync.
- Preserve relation cardinality in results: `many-to-one` returns object/null, `one-to-many` returns array.
- Make the final API type-safe against schema fields, relation names, relation targets, and selected result shape.

## Non-goals for the first relational design

- No migrations or backfills.
- No many-to-many, through, polymorphic, aggregate, OR, NOT, full-text, or computed-field query syntax.
- No live nested collection handles; nested relation results are snapshots embedded in parent rows.
- No compatibility requirement for the old fluent `QueryBuilder` public API. Tandem is unreleased, so the object query shape should become canonical.

## Query options

### `select`

`select` is an inclusion map of scalar fields on the queried collection:

```ts
select: { id: true, title: true }
```

Rules:

- Omitted `select` means all scalar fields on that collection.
- Only `true` is allowed as a field value.
- `false`, exclusion maps, aliases, and computed fields are out of scope.
- Relations are never selected through `select`; they are included only through `with`.
- Tandem may read join fields internally even when omitted from `select`, but hidden join fields must not appear in the result unless selected.
- `select: "*"` is not part of the new public object API. If retained internally during migration, normalize it to omitted `select` before exposing docs or public types.

### `where`

`where` is an AND-only object keyed by scalar fields on the current collection:

```ts
where: {
	status: "active",
	done: false,
	priority: { gt: 2 },
	updatedAt: { gte: since, lt: before },
}
```

Rules:

- A bare value is equality shorthand and encodes as `eq`.
- Operator objects may use `eq`, `gt`, `lt`, `gte`, and `lte`.
- Multiple fields and multiple operators on one field are combined with AND.
- `OR`, `NOT`, `in`, `contains`, relation-field predicates, and arbitrary predicate functions are out of scope for v1.
- Nested relation `where` clauses target the related collection, not the parent collection.

### `orderBy`

`orderBy` is an ordered object keyed by scalar fields on the current collection:

```ts
orderBy: { updatedAt: "desc", id: "asc" }
```

Rules:

- Values are only `"asc"` or `"desc"`.
- Property insertion order defines sort precedence for multiple fields.
- Omitted `orderBy` leaves storage scan order unspecified.
- Callers that need stable pagination must provide an explicit order.
- Nested relation `orderBy` clauses target the related collection.

Tradeoff: object syntax is ergonomic, but array syntax would make precedence more explicit. If multi-column sorting becomes a major API concern, reconsider this before implementation.

### `limit` and `offset`

`limit` and `offset` are non-negative integers applied after `where` and `orderBy`:

```ts
limit: 50,
offset: 100,
```

Rules:

- Omitted `limit` means no maximum result count.
- Omitted `offset` means `0`.
- `limit: 0` is valid and returns no rows.
- Negative, fractional, `NaN`, and infinite values are invalid.
- On `one-to-many` relation includes, `limit` and `offset` apply per parent.
- On `many-to-one` relation includes, `limit` and `offset` are invalid because the relation result is already at most one object.

### `with`

`with` is an object keyed by relation names from `defineRelations`:

```ts
with: {
	author: true,
	messages: {
		select: { id: true, body: true, createdAt: true },
		where: { deleted: false },
		orderBy: { createdAt: "asc" },
		limit: 100,
		with: {
			author: { select: { id: true, name: true } },
		},
	},
}
```

Rules:

- `true` means include the relation with all scalar fields and no nested filters, sorting, pagination, or nested relations.
- Object values accept `select`, `where`, `with`, `orderBy`, `limit`, and `offset`, scoped to the relation target collection.
- Relation objects do not use field-name shorthand like `{ id: true }`; selected relation fields must live under `select`.
- Unknown relation names are invalid.
- Requested relation keys are always present in each parent result.
- Nested `with` recursion is part of the design, even if early execution phases limit depth for simplicity.

## Relation result shape

Included relations are embedded under their relation name on each parent row.

`many-to-one` relation result:

```ts
type PostWithAuthor = Post & {
	author: User | null
}
```

Rules:

- The key is present when requested.
- The value is the selected related object when a matching record exists.
- The value is `null` when the parent join field is missing, the target record is missing, or relation-level `where` filters the target out.
- A `many-to-one` relation never returns an array.

`one-to-many` relation result:

```ts
type ThreadWithMessages = Thread & {
	messages: Message[]
}
```

Rules:

- The key is present when requested.
- The value is an array snapshot, not a live collection object.
- No matches produce `[]`.
- `limit: 1` still returns an array with zero or one item. It does not collapse to a single object.
- Subscription updates should eventually re-emit the parent row instead of exposing mutable nested child collections.

## Type-safety requirements

The design is type-safe only if implementation keeps query options tied to schema and relation metadata. A loose public type like `Record<string, any>` is not acceptable.

The public API should enforce these compile-time rules:

- `collection` must be a known collection name from the client schema.
- `select`, `where`, and `orderBy` keys must be scalar fields on the current collection.
- `where` values must be assignable to the field's TypeScript type.
- Comparison operators should be restricted to comparable field types where practical.
- `with` keys must be relation names defined for the current collection.
- Nested `with` options must be scoped to the target collection of that relation.
- Result types must reflect selected scalar fields, included nested relations, and relation cardinality.

This should type-check:

```ts
const threads = useQuery({
	collection: "threads",
	select: { id: true, title: true },
	where: { status: "active" },
	with: {
		messages: {
			select: { id: true, body: true },
			limit: 1,
		},
	},
})

threads[0].id
threads[0].messages[0]?.body
```

These should fail at compile time:

```ts
useQuery({ collection: "threads", select: { missingField: true } })
useQuery({ collection: "threads", where: { status: 123 } })
useQuery({ collection: "threads", orderBy: { missingField: "asc" } })
useQuery({ collection: "threads", with: { missingRelation: true } })
```

Implementation detail: `defineRelations` must preserve literal relation names, target collections, and `many-to-one`/`one-to-many` relation types. If relation metadata widens too early to `AnyRelations<Schema>`, `with` and nested result inference will be weakly typed.

## Server authorization model

Ad hoc object queries can work with a single backend `query` endpoint as long as the endpoint treats client queries as untrusted shape requests, not authorization decisions.

The backend should always execute the query inside a server-derived security context:

```ts
async function handleQuery(request: Request, session: Session) {
	const query = parseAndValidateQuery(await request.json())

	return db
		.withContext({
			tenantId: session.tenantId,
			userId: session.userId,
		})
		.runQuery(query)
}
```

Required server behavior:

- Derive tenant/user context from authenticated session state, never from client-provided query filters.
- Apply tenant scoping and RLS to every collection touched by the query, including nested relations.
- Validate query shape: collection names, field names, relation names, operators, include depth, and maximum limits.
- Enforce field-level and relation-level allowlists if some columns or relations are sensitive; RLS alone usually protects rows, not columns.
- Cap resource usage with maximum `limit`, maximum `offset`, maximum include depth, and possibly maximum relation fanout.

With this model, named query registries are optional ergonomics rather than required for security. A Zero-like named query layer may still be useful later for app-defined reusable queries or policy-heavy endpoints.

## Comparison with inspirations

### Drizzle Relations v2

Drizzle is the closest syntactic inspiration. Its relational reads use an object include tree under `with`, relation keys are embedded on the parent row, many-to-one relations produce an object or nullable object, and one-to-many relations produce arrays.

Drizzle-style query:

```ts
const threads = await db.query.threads.findMany({
	columns: { id: true, title: true, status: true },
	where: { status: "active" },
	with: {
		messages: {
			columns: { id: true, body: true, createdAt: true },
			orderBy: { createdAt: "desc" },
			limit: 1,
		},
	},
})
```

Equivalent Tandem proposal:

```ts
const threads = useQuery({
	collection: "threads",
	select: { id: true, title: true, status: true },
	where: { status: "active" },
	with: {
		messages: {
			select: { id: true, body: true, createdAt: true },
			orderBy: { createdAt: "desc" },
			limit: 1,
		},
	},
})
```

Tandem follows Drizzle on `with`, relation cardinality, and embedded relation results. Tandem differs by using `select` instead of `columns`, a single query-object root API instead of `db.query.collection.findMany`, and no relation-definition options like `optional`, `alias`, `through`, or predefined relation filters in v1.

### TanStack DB query collections

TanStack DB focuses on collections, live queries, and predicate push-down into a query function. Its live-query API uses expression builders; its remote boundary receives typed load-subset options with `where`, `orderBy`, `limit`, and `offset`.

TanStack DB live-query style:

```ts
const activeThreads = createLiveQueryCollection({
	query: (q) =>
		q
			.from({ thread: threadsCollection })
			.where(({ thread }) => eq(thread.status, "active"))
			.orderBy(({ thread }) => thread.updatedAt, "desc")
			.limit(50)
			.select(({ thread }) => ({
				id: thread.id,
				title: thread.title,
				status: thread.status,
			})),
})
```

Equivalent Tandem proposal:

```ts
const activeThreads = useQuery({
	collection: "threads",
	select: { id: true, title: true, status: true },
	where: { status: "active" },
	orderBy: { updatedAt: "desc" },
	limit: 50,
})
```

TanStack predicate push-down boundary:

```ts
queryFn: async (ctx) => {
	const { where, orderBy, limit, offset } = ctx.meta.loadSubsetOptions
	const parsed = parseLoadSubsetOptions({ where, orderBy, limit, offset })
	return api.getThreads(parsed)
}
```

Tandem should borrow the predicate push-down idea but keep the public query as a plain object rather than callback/expression-builder AST.

### Zero queries

Zero emphasizes named query registries. Apps define queries with `defineQuery`, validate arguments with a schema, and run the same query definition on client and server through ZQL.

Zero named-query style:

```ts
export const queries = defineQueries({
	threads: {
		active: defineQuery(
			z.object({ limit: z.number().int().nonnegative() }),
			({ args: { limit } }) =>
				zql.thread
					.where("status", "active")
					.orderBy("updatedAt", "desc")
					.limit(limit),
		),
	},
})

const [threads] = useQuery(queries.threads.active({ limit: 50 }))
```

Equivalent Tandem proposal:

```ts
const threads = useQuery({
	collection: "threads",
	where: { status: "active" },
	orderBy: { updatedAt: "desc" },
	limit: 50,
})
```

Zero is stronger for named, validated, server-owned query definitions. Tandem's ad hoc shape is more direct for local-first UI reads and remains compatible with secure server execution if the backend enforces tenant context, RLS, query validation, and resource caps.

## Roadmap mapping

This design resolves the README group `Finalize public relational query shape`:

- Object-style query API: `useQuery({ collection: "threads", select, where, with, orderBy, limit })`
- Exact `select`, `where`, `orderBy`, `limit`, and `offset` syntax
- Relation result shape for `many-to-one` vs `one-to-many`

The next README groups should be specified and implemented separately:

- Type inference for relational queries
- Encode relational queries
- Execute relational queries locally
- Subscribe to relational queries locally
- Sync relational subscriptions through remote
- Tests and examples

## Important files and references

- `README.md` - Relational Queries v2 roadmap.
- `packages/core/src/schema/Schema.ts` - Runtime schema and relation helpers.
- `packages/core/src/query/Query.ts` - Current flat builder API and likely query type/normalization home.
- `packages/core/src/TandemClient.ts` - Public run/subscribe surface.
- `packages/core/src/Database.ts` - Current flat executor.
- `packages/core/src/schema/Schema.ts` - Runtime schema and relation helpers.
- `packages/types/src/types.ts` - Current shared query and relation types.
- `https://www.notion.so/Relational-tandem-258ac9fb35f1801e88eaf858b5401317` - Product direction and examples.
- `https://orm.drizzle.team/docs/relations-v2` - Drizzle relational query inspiration.
- `https://tanstack.com/db/latest/docs/collections/query-collection` - TanStack DB query collection and predicate push-down inspiration.
- `https://zero.rocicorp.dev/docs/queries` - Zero named query and validation inspiration.
