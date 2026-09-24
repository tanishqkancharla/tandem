# Mutations

## What

Handles data modifications with optimistic updates, transactions, and rollback support. Ensures data consistency during concurrent modifications.

## How to use

```typescript
// Simple mutations
const tx = db.transact();
tx.set("User", { id: "123", name: "John" });
tx.remove("Task", "456");
await db.commit(tx);

// Batch mutations
const tx = db.transact();
users.forEach((user) => tx.set("User", user));
await db.commit(tx);
```

## How it works

1. **Transactions**: Group operations atomically
2. **Optimistic Updates**: Apply locally first
3. **Streaming**: Send to server in background
4. **Rollback**: Revert on conflicts
5. **Replay**: Re-apply non-conflicting changes

## Mutation types

- `set` - Create or update record
- `remove` - Delete record
- Invertible variants store rollback data

## Common patterns

**Optimistic updates:**

```typescript
// Changes appear immediately
tx.set("User", updatedUser);
db.commit(tx); // Async, doesn't block UI
```

**Batch operations:**

```typescript
const tx = db.transact();
largeDataSet.forEach((item) => tx.set("Item", item));
await db.commit(tx); // Single transaction
```
