# Storage Layer

## What

Persistent tuple storage with IndexedDB backend. Handles data persistence, caching, and provides storage abstraction for the database layer.

## How to use

```typescript
import { IndexedDbAdapter } from "./IndexedDbAdapter";

const storage = new IndexedDbAdapter({
	dbName: "my-app",
	version: 1,
});

// Used internally by TandemClient
const db = new TandemClient({ localStore: storage });
```

## How it works

- **IndexedDB**: Browser persistent storage
- **Tuple Model**: Stores data as `["record", collection, id]` tuples
- **Caching**: In-memory cache with write-through
- **Batching**: Groups writes for better performance

## Key implementation notes

- Single IndexedDB object store for all data
- Composite indexes for efficient querying
- Automatic retry with exponential backoff
- Graceful fallback to in-memory storage on errors
- ACID properties maintained through transactions
