# What is Tandem?

Tandem is a sync engine and database for building collaborative applications. It provides real-time synchronization between client-side state and your backend, enabling instant UI updates while maintaining data consistency across multiple clients.

## The Problem

Building collaborative applications is challenging because you need to handle:

- **Optimistic Updates**: Changes should appear instantly in the UI
- **Real-time Sync**: Multiple clients need to see each other's changes
- **Conflict Resolution**: Handle concurrent edits gracefully
- **Offline Support**: Work when network is intermittent
- **Data Consistency**: Ensure all clients converge to the same state

## The Solution

Tandem solves these challenges by providing:

**Client-Side Database**: A fast, persistent, query-able database that lives in your browser. Your UI reads directly from this database for instant responsiveness.

**Optimistic Updates**: Changes are applied locally first, then synchronized to the server in the background. Your UI feels instant while staying consistent.

**Real-time Sync**: Automatic bidirectional synchronization between client and server. Changes made by other clients appear in real-time.

**Conflict Resolution**: When conflicts occur, Tandem automatically rolls back optimistic changes, applies server updates, and replays client changes on top.

**Type Safety**: Full TypeScript integration with schema validation and type-safe queries.

## Architecture

Tandem consists of three main components:

### 1. TandemClient
The main interface for your application. Provides:
- Type-safe CRUD operations
- Query builder with subscriptions
- Transaction support
- Automatic sync management

### 2. Local Database
A persistent, query-able database that stores your application state:
- **Storage Layer**: Persists to IndexedDB for offline support
- **Query Engine**: SQL-like operations with full TypeScript integration
- **Subscriptions**: Real-time updates when data changes

### 3. Sync Engine
Handles synchronization between client and server:
- **Push**: Streams local changes to your server
- **Pull**: Fetches updates from your server
- **Conflict Resolution**: Automatically merges concurrent changes
- **Offline Support**: Queues changes when disconnected

## Key Features

- **Instant UI**: Changes appear immediately, sync happens in background
- **Type Safety**: Full TypeScript schema integration
- **Query Language**: SQL-like queries with subscriptions
- **Optimistic Updates**: Changes are applied locally first
- **Conflict Resolution**: Automatic handling of concurrent edits
- **Offline Support**: Works without network connection
- **Real-time Sync**: See changes from other clients instantly
- **Persistence**: Data survives browser restarts

## Use Cases

Tandem is perfect for applications that need:

- **Collaborative Editing**: Documents, spreadsheets, design tools
- **Real-time Dashboards**: Analytics, monitoring, live data
- **Team Productivity**: Task management, project planning
- **Social Applications**: Chat, forums, activity feeds
- **Offline-First Apps**: Mobile apps, field work tools

## How It Works

1. **Define Your Schema**: Describe your data structure with TypeScript types
2. **Create Queries**: Use the query builder to read and subscribe to data
3. **Make Changes**: Use transactions to modify data locally
4. **Sync Automatically**: Tandem handles synchronization in the background
5. **Handle Conflicts**: Automatic conflict resolution keeps everyone in sync

## Next Steps

- [**Quickstart Guide**](./quickstart.md) - Get up and running in 5 minutes
- [**How Tandem Works**](./how_does_tandem_work.md) - Deep dive into the sync model
- [**Implementing Remote**](./how_to_implement_remote.md) - Backend integration guide
