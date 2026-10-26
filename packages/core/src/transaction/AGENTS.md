# Mutations

## What

Records data modifications as mutations. A transaction applies its writes locally and records each as an op, and `TandemClient.commit` turns the ops into a mutation for the sync engine.

## How to use

```typescript
// Simple mutations
const tx = db.transact()
tx.set("User", { id: "123", name: "John" })
tx.remove("Task", "456")
await db.commit(tx)

// Batch mutations
const tx = db.transact()
users.forEach((user) => tx.set("User", user))
await db.commit(tx)
```

## How it works

1. **Transactions**: Group operations atomically
2. **Optimistic Updates**: Apply locally first
3. **Streaming**: Send to server in background
4. **Replay**: After a pull, `Database.applyPull` restores tracked records from sparse base tuples and replays remaining outbox operations within the same root transaction.

## Mutation types

- `set` - Create or update record
- `remove` - Delete record by id, recorded even when the record isn't local
- `update` - Assign supplied top-level payload fields on an existing record; missing records remain absent

`TandemServerTransaction.append` is server-only and never becomes a client mutation; see the sync engine's live appends.

Ops store only the new value, id, or partial payload, never the previous value. Replay reapplies each op in order. `tx.update(collection, id, payload)` accepts explicit partial assignments, copies their supplied fields, and records an `update` operation. Omitted fields remain untouched; nested values replace their top-level field. Equal assignments still record intent. Missing records and empty payloads add no operation. Reject payload identity changes; field deletion is not supported.

`MutationApi.codec(schema)` belongs at a transport boundary: encode mutations before serializing and decode them before calling a runtime remote. It runs collection codecs on set values, update payloads, and identities; it preserves mutation IDs and operation order. Decode all mutations before applying the request so a codec failure cannot apply a prefix. Do not run validation-only encode/decode passes in `TandemServer`.

## Common patterns

**Optimistic updates:**

```typescript
// Changes appear immediately
tx.set("User", updatedUser)
db.commit(tx) // Async, doesn't block UI
```

**Batch operations:**

```typescript
const tx = db.transact()
largeDataSet.forEach((item) => tx.set("Item", item))
await db.commit(tx) // Single transaction
```
