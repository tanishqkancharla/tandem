# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Tandem is a sync engine and database for building collaborative applications. It provides real-time synchronization between client-side state and your backend, enabling instant UI updates while maintaining data consistency across multiple clients.

### Key Components

- **TandemClient**: Main interface providing type-safe CRUD operations, query builder, and sync management
- **Local Database**: Persistent, query-able database stored in IndexedDB with SQL-like operations
- **Sync Engine**: Handles bidirectional synchronization with optimistic updates and conflict resolution
- **Query System**: Type-safe query builder with subscriptions for real-time updates
- **Storage Layer**: IndexedDB adapter for persistent client-side storage

## Development Commands

```bash
# Build the project
npm run build

# Type checking
npm run tsc

# Lint and type check
npm run lint

# Format code
npm run format

# Run tests
npm run test

# Run tests in watch mode
npm run test --watch

# Full release build
npm run release
```

## Architecture

### Core Architecture
The project follows a layered architecture:

1. **Application Layer**: TandemClient provides the main API
2. **Query Layer**: Type-safe query builder with subscriptions (`src/query/`)
3. **Database Layer**: Local database with transaction support (`src/Database.ts`)
4. **Sync Layer**: Handles client-server synchronization (`src/sync/`)
5. **Storage Layer**: IndexedDB persistence (`src/storage/`)
6. **Transaction Layer**: ACID transactions for data consistency (`src/transaction/`)

### Sync Model
Tandem uses a Git-inspired sync model:
- **Optimistic Updates**: Changes applied locally first, then synced
- **Mutations**: Structured operations that can be applied both locally and remotely
- **Scan Windows**: Define what data each client subscribes to
- **Conflict Resolution**: Automatic rebase when conflicts occur (rollback → apply server patch → replay local changes)

### Key Files
- `src/TandemClient.ts`: Main client interface
- `src/Database.ts`: Local database implementation
- `src/sync/SyncEngine.ts`: Synchronization logic
- `src/query/Query.ts`: Query builder and execution
- `src/storage/Storage.ts`: Storage abstraction layer
- `src/transaction/Transaction.ts`: Transaction management
- `src/types.ts`: Core type definitions

## Technology Stack

- **Language**: TypeScript with strict type checking
- **Storage**: IndexedDB via `idb` library
- **Database**: Custom tuple-database implementation
- **Testing**: Vitest
- **Build**: tsx with custom build scripts
- **Linting**: ESLint with TypeScript support
- **Publishing**: npm and JSR (jsr.io)

## Testing

Tests are located alongside source files with `.test.ts` suffix. The project uses Vitest with:
- Isolation disabled for performance (`isolate: false`)
- `allowOnly` enabled for development (disabled in CI)

## Code Conventions

- Use TypeScript with strict type checking
- Follow ESLint configuration with Prettier formatting
- Prefix unused variables with underscore (`_variable`)
- Use named exports for public API
- Type-safe APIs throughout - leverage TypeScript's type system
- Mutations and operations are strongly typed
- Use tuple-database for efficient storage and querying

## Common Patterns

### Creating Queries
```typescript
// Basic query
const users = db.query({ collection: "users", where: { active: true } })

// With subscriptions
const sub = db.subscribe({ collection: "users" }, (users) => {
  // Handle updates
})
```

### Transactions
```typescript
const tx = db.transact()
tx.set("collection", { id: "123", data: "value" })
const commit = db.commit(tx)
await commit
```

### Remote API Implementation
```typescript
const remote = {
  async push(mutations) {
    // Send to server
  },
  async pull({ cookie, scanWindow }) {
    // Fetch updates
    return { cookie, patch, lastMutationId }
  }
}
```

## Important Notes

- This is a work in progress - check README.md for current status
- The project uses tuple-database for efficient storage
- All data is stored as tuples in format `["record", collection, id]`
- Sync happens automatically in background (~150ms intervals)
- Conflicts are resolved using last-write-wins at field level
- Local operations have <1ms latency
