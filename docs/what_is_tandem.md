# What is Tandem?

Tandem is a sync engine and database for building collaborative applications. It enables **instantaneous UI updates** and **real-time synchronization** by removing server round-trips from your application's critical path.

## The Problem

Building modern collaborative applications faces a fundamental challenge: users expect both **instant responsiveness** and **real-time collaboration**. Traditional approaches force you to choose:

- **Optimistic updates**: Fast UI, but complex conflict resolution and potential inconsistencies
- **Server-first updates**: Consistent data, but slow, laggy user experience
- **Real-time solutions**: Complex WebSocket management, connection handling, and state synchronization

## The Solution

Tandem solves this by providing a **local-first database** that automatically synchronizes with your backend. Your application works with local data that's instantly available, while Tandem handles the complex sync logic in the background.

```typescript
// Create a local transaction
const tx = db.transact()
tx.set("todos", { id: "1", text: "Learn Tandem", complete: false })

// Changes appear instantly in your UI
await db.commit(tx) // Syncs to server automatically
```

## Key Benefits

### 🚀 **Instant UI Updates**
All operations happen against local data first. Your UI updates immediately without waiting for server responses.

### 🔄 **Automatic Sync**
Changes are automatically pushed to your server and pulled from other clients. No manual sync code required.

### 🎯 **Type-Safe Queries**
Built-in TypeScript support with a powerful query builder that feels like SQL but works with your TypeScript types.

### 💾 **Persistent Storage**
Uses IndexedDB for persistent local storage. Your app works offline and resumes sync when reconnected.

### 🤝 **Conflict Resolution**
Handles concurrent changes gracefully with a proven sync model inspired by Replicache.

## How It Works

Tandem uses a **push-pull sync model**:

1. **Local Changes**: Your app modifies local data using transactions
2. **Optimistic Updates**: Changes appear instantly in your UI
3. **Push**: Mutations are queued and sent to your server
4. **Pull**: Server updates are fetched and merged with local changes
5. **Conflict Resolution**: Conflicting changes are automatically resolved

## Core Components

### Database
A local tuple-based database that stores your application data with full transaction support.

### Query System
Type-safe query builder with support for filtering, ordering, and subscriptions.

### Sync Engine
Handles the complex logic of synchronizing local changes with your remote server.

### Storage Layer
Persistent storage using IndexedDB with automatic caching and batching.

## Who Should Use Tandem?

Tandem is perfect for applications that need:

- **Collaborative features** (multiple users editing shared data)
- **Real-time updates** (changes appear instantly across clients)
- **Offline support** (app works without internet connection)
- **Complex data relationships** (more than simple key-value storage)
- **Type safety** (TypeScript-first development)

## Example Use Cases

- **Todo applications** with real-time collaboration
- **Document editors** with conflict-free editing
- **Project management tools** with live updates
- **Chat applications** with offline message queuing
- **Data dashboards** with real-time metrics

## Getting Started

Ready to build your next collaborative application? Check out the [Quickstart Guide](./quickstart.md) to get up and running in minutes.

Want to understand how Tandem works under the hood? Read [How Does Tandem Work?](./how_does_tandem_work.md) for a deep dive into the sync architecture.

---

*Tandem is inspired by [Replicache](https://replicache.dev) and builds on proven patterns for client-side sync.*