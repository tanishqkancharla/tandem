# Query System

## What

Serializable object query encoding for Tandem collection queries and relational includes.

## How to use

```typescript
const users = client.query({
	collection: "users",
	where: { active: true },
})

const recent = client.query({
	collection: "tasks",
	where: { status: "pending", createdAt: { gt: yesterday } },
	orderBy: { priority: "desc" },
	limit: 10,
})

const sub = client.subscribe(
	{ collection: "users", where: { active: true } },
	(users) => console.log("Updated:", users),
)
```

## Supported operations

- `select` - Choose fields with `{ fieldName: true }`
- `where` - Filter by equality or comparison operators (`eq`, `gt`, `lt`, `gte`, `lte`)
- `orderBy` - Sort fields by `"asc"` or `"desc"`
- `limit` / `offset` - Page result sets
- `with` - Include related records through relation metadata
