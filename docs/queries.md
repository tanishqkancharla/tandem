# Queries

A query is a plain, JSON-serializable object. `TandemClient`, `TandemServer`, and `useTandemQuery` all accept it.

```ts
const tasks = client.query({
	collection: "tasks",
	select: { id: true, title: true, priority: true },
	where: { status: "pending", createdAt: { gt: yesterday } },
	orderBy: { priority: "desc", id: "asc" },
	limit: 10,
	offset: 0,
})
```

Only `collection` is required. Every option is typed against the schema, so an unknown field, relation, or mismatched value type is a compile error.

## Options

| Option    | Shape                                          | Notes                                                                  |
| --------- | ---------------------------------------------- | ---------------------------------------------------------------------- |
| `select`  | `{ field: true }`                              | Omit to return all fields. The result type narrows to selected fields. |
| `where`   | `{ field: value \| { eq, gt, lt, gte, lte } }` | A bare value means `eq`. All conditions combine with AND.              |
| `orderBy` | `{ field: "asc" \| "desc" }`                   | Key order sets sort precedence. Omit it and the order is unspecified.  |
| `limit`   | `number`                                       | Maximum number of rows.                                                |
| `offset`  | `number`                                       | Rows to skip, applied after `where` and `orderBy`.                     |
| `with`    | `{ relation: true \| QueryOptions }`           | Includes related records. See [Relations](#relations).                 |

`OR`, `NOT`, `in`, and filters on related fields are not supported.

## Subscriptions

`subscribe` returns the current result and calls the callback whenever the result changes. Call `destroy` to stop.

```ts
const { result, destroy } = client.subscribe(
	{ collection: "users", where: { active: true } },
	(users) => render(users),
)
```

A subscription also adds the query to the client's scan window, which tells the remote which data to send. See [How sync works](sync.md#scan-windows).

In React, `useTandemQuery(query)` subscribes for the component's lifetime. It re-subscribes when the serialized query changes and returns `undefined` when `query` is `undefined`.

## Relations

Define relations with `defineRelations` and pass them to the client alongside the schema. Relations need a runtime schema whose collections list their fields.

```ts
import {
	collection,
	defineRelations,
	defineSchema,
	t,
	TandemClient,
} from "@tanishqkancharla/tandem-core"

const schema = defineSchema({
	users: collection({ id: t.id(), name: t.string() }),
	threads: collection({ id: t.id(), ownerId: t.string(), title: t.string() }),
	messages: collection({
		id: t.id(),
		threadId: t.string(),
		body: t.string(),
		createdAt: t.number(),
	}),
})

const relations = defineRelations(schema, ({ one, many }) => ({
	threads: {
		owner: one("users", { from: "ownerId", to: "id" }),
		messages: many("messages", { from: "id", to: "threadId" }),
	},
}))

const client = new TandemClient({ schema, relations })
```

- `one` defines a many-to-one relation. Its result is the related row or `null`.
- `many` defines a one-to-many relation. Its result is an array, which is `[]` when nothing matches.

Include relations with `with`. `true` includes all fields. An object accepts the same options as a root query, scoped to the related collection, and can nest further `with` clauses.

```ts
const threads = client.query({
	collection: "threads",
	select: { id: true, title: true },
	with: {
		owner: { select: { name: true } },
		messages: {
			orderBy: { createdAt: "desc" },
			limit: 1,
		},
	},
})

threads[0].owner?.name
threads[0].messages[0]?.body
```

On one-to-many includes, `limit` and `offset` apply per parent row. Tandem reads join fields internally, so `select` can leave them out. Subscriptions re-emit when included child records change.

The reasoning behind this shape is in [Relational queries design](design/relational-queries.md).
