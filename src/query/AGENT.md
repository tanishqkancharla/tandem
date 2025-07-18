# Query System

## What

Type-safe query builder and execution engine. Provides SQL-like operations with full TypeScript integration and subscription support.

## How to use

```typescript
import { q } from "@repo/tandem";

// Basic queries
const users = await db.run(q.User.select().where("active", true));

// Complex queries
const recent = await db.run(
	q.Task.select()
		.where("status", "pending")
		.where("createdAt", ">", yesterday)
		.order("priority", "desc")
		.limit(10),
);

// Subscriptions
const sub = db.subscribe(q.User.select().where("active", true), (users) =>
	console.log("Updated:", users),
);
```

## How it works

- **Query Builder**: Fluent API for building queries
- **Type Safety**: Full TypeScript schema integration
- **Tuple Translation**: Converts to tuple storage operations
- **Subscriptions**: Real-time updates via mutation tracking
- **Optimization**: Automatic index usage and caching

## Supported operations

- `select()` - Choose fields (`"*"` or specific fields)
- `where()` - Filter by equality/comparison (`=`, `>`, `<`, `>=`, `<=`)
- `order()` - Sort by field (`"asc"` or `"desc"`)
- `limit()` - Limit results count
