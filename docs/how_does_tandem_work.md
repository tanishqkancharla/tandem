# How Does Tandem Work?

Tandem enables instantaneous UI updates and real-time collaboration by implementing a sophisticated sync engine inspired by distributed version control systems like Git. This document explains the core architecture and sync model that makes it all possible.

## Core Architecture

Tandem consists of four main components that work together:

```
┌─────────────────┐    ┌─────────────────┐    ┌─────────────────┐
│   Application   │    │   Query System  │    │   Sync Engine   │
│                 │◄──►│                 │◄──►│                 │
│  (Your Code)    │    │  (Type-safe)    │    │  (Push/Pull)    │
└─────────────────┘    └─────────────────┘    └─────────────────┘
          │                       │                       │
          │                       ▼                       │
          │             ┌─────────────────┐               │
          │             │    Database     │               │
          │             │                 │               │
          │             │  (Transactions) │               │
          │             └─────────────────┘               │
          │                       │                       │
          │                       ▼                       │
          │             ┌─────────────────┐               │
          │             │  Storage Layer  │               │
          │             │                 │               │
          │             │  (IndexedDB)    │               │
          │             └─────────────────┘               │
          │                                               │
          │                                               ▼
          │                                    ┌─────────────────┐
          │                                    │  Remote Server  │
          │                                    │                 │
          │                                    │  (Your Backend) │
          │                                    └─────────────────┘
```

## The Sync Model

Tandem uses a **push-pull sync model** that ensures data consistency while providing instant UI updates:

### 1. Local-First Operations

All operations happen against local data first:

```typescript
// This runs immediately against local data
const tx = db.transact()
tx.set("todos", { id: "1", text: "Learn Tandem", complete: false })
await db.commit(tx) // UI updates instantly
```

**What happens internally:**
1. Transaction is applied to the local tuple database
2. Change is immediately visible in query results
3. UI subscribers are notified and update instantly
4. Mutation is queued for sync to remote server

### 2. Speculative Mutations

When you commit a transaction, Tandem creates a **speculative mutation** that represents the change:

```typescript
// Internal representation of your change
const mutation = {
  id: "mut_123",
  ops: [
    {
      type: "set",
      collection: "todos",
      value: { id: "1", text: "Learn Tandem", complete: false },
      prevValue: undefined // This is an insert
    }
  ]
}
```

These mutations are:
- **Immediately applied** to local data
- **Queued for pushing** to the remote server
- **Tracked as speculative** until server confirms them

### 3. Push Phase

The sync engine continuously pushes local mutations to your remote server:

```typescript
// Tandem calls your remote API
await remote.push({
  clientId: "client_456",
  mutations: [mutation]
})
```

**Push characteristics:**
- Happens **asynchronously** in the background
- Mutations are batched for efficiency
- Retries automatically on failure
- Maintains order of operations

### 4. Pull Phase

Periodically, Tandem pulls updates from the server:

```typescript
// Tandem calls your remote API
const result = await remote.pull({
  clientId: "client_456",
  cookie: "version_789", // Last known server version
  scanWindow: [
    { collection: "todos", select: "*" } // What queries are active
  ]
})
```

**Pull characteristics:**
- Only fetches data for active queries (**scan window**)
- Uses **incremental updates** via cookies/versions
- Happens on a timer and when "poked" by server

### 5. Conflict Resolution

When server updates arrive, Tandem performs a **three-way merge**:

```
Local State:     [A, B, C_local]
Server Update:   [A, B, C_server, D]
Speculative:     [E_local]

Result:          [A, B, C_server, D, E_local]
```

**The merge process:**
1. **Rollback**: Remove all speculative mutations from local state
2. **Apply**: Apply server patch to get canonical state
3. **Replay**: Re-apply non-conflicting speculative mutations on top

```typescript
// Conceptual implementation
function applyServerUpdate(patch, speculativeMutations) {
  // 1. Rollback speculative changes
  const rollbackOps = speculativeMutations.map(invertMutation)
  tupleDb.commit(rollbackOps)
  
  // 2. Apply server patch
  const serverOps = patchToWriteOps(patch)
  tupleDb.commit(serverOps)
  
  // 3. Replay speculative mutations
  const replayOps = speculativeMutations.map(mutationToWriteOps)
  tupleDb.commit(replayOps)
}
```

## Data Model

### Tuple Storage

Tandem stores all data as **tuples** in the format:

```typescript
["record", collection, id] → value
```

Examples:
```typescript
["record", "todos", "1"] → { id: "1", text: "Learn Tandem", complete: false }
["record", "lists", "work"] → { id: "work", name: "Work Tasks", color: "blue" }
```

**Benefits:**
- Efficient range queries
- Simple conflict resolution
- Uniform storage model
- Easy to reason about

### Invertible Mutations

Tandem tracks not just what changed, but also what the **previous value** was:

```typescript
type InvertibleMutation = {
  type: "set"
  collection: "todos"
  value: { id: "1", text: "Updated", complete: true }
  prevValue: { id: "1", text: "Original", complete: false } // Key!
}
```

This enables:
- **Rollback** of speculative changes
- **Conflict detection** and resolution
- **Undo/redo** functionality (future feature)

## Real-time Updates

### Poke System

For real-time updates, Tandem uses a **poke system**:

```typescript
// Server notifies client of available updates
client.poke() // "Hey, new data is available!"

// Client responds by pulling updates
const updates = await remote.pull({ ... })
```

**Poke characteristics:**
- Lightweight notification (no data transfer)
- Triggers immediate pull request
- Can be implemented via WebSocket, SSE, or polling

### Scan Windows

Tandem only syncs data that's **actively being queried**:

```typescript
// Active subscription creates scan window entry
const { destroy } = db.subscribe("todos", q => q.select("*"), callback)

// Scan window: [{ collection: "todos", select: "*" }]
```

**Benefits:**
- Reduces bandwidth usage
- Improves performance
- Enables fine-grained permissions

## Query System

### Type-Safe Queries

Tandem's query system provides SQL-like operations with full TypeScript support:

```typescript
// Compiled query
const query = {
  collection: "todos",
  select: ["id", "text"],
  where: [["complete", "=", false]],
  order: [["createdAt", "desc"]],
  limit: 10
}

// Execution against tuple storage
const results = tupleDb.scan({
  gte: ["record", "todos", null],
  lte: ["record", "todos", true]
}).filter(/* where clauses */)
  .sort(/* order clauses */)
  .slice(0, 10) // limit
```

### Subscriptions

Queries can be **subscribed to** for reactive updates:

```typescript
// When any tuple matching the query changes
tupleDb.subscribe({ 
  gte: ["record", "todos", null],
  lte: ["record", "todos", true]
}, (writeOps) => {
  // Re-run query and notify subscribers
  const newResults = runQuery(query)
  callback(newResults)
})
```

## Performance Optimizations

### Batching

Multiple operations are batched together:

```typescript
// Multiple mutations in one transaction
const tx = db.transact()
tx.set("todos", todo1)
tx.set("todos", todo2)
tx.remove("todos", "old-id")
await db.commit(tx) // Single batch to server
```

### Throttling

Storage writes are throttled to prevent excessive disk I/O:

```typescript
// Writes are batched over 120ms window
const storageQueue = new ThrottleQueue(writeToStorage, 120)
```

### Incremental Sync

Only changed data is synchronized:

```typescript
// Server returns only changes since last cookie
const delta = await remote.pull({
  cookie: "version_456", // Last known version
  scanWindow: activeQueries
})
```

## Error Handling

### Connection Failures

Tandem gracefully handles network failures:

```typescript
// Mutations queue up during offline periods
const mutations = [mut1, mut2, mut3] // Queued offline
await remote.push({ mutations }) // Sent when reconnected
```

### Consistency Guarantees

Tandem provides **eventual consistency**:

1. **Local consistency**: All local operations are immediately consistent
2. **Causal consistency**: Operations from the same client are applied in order
3. **Eventual consistency**: All clients eventually converge to the same state

## Summary

Tandem's architecture enables the best of both worlds:

- **Instant UI**: Changes appear immediately in your interface
- **Real-time sync**: Updates propagate automatically between clients
- **Conflict resolution**: Concurrent changes are merged intelligently
- **Offline support**: Works without internet connection
- **Type safety**: Full TypeScript support throughout

The key insight is treating client-side changes as **speculative** until confirmed by the server, while providing a smooth merge process that preserves user intent.

---

**Next:** Learn how to implement your server-side sync endpoints in [How to Implement Remote](./how_to_implement_remote.md).