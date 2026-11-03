# Storage adapters

A storage adapter connects `TandemServer` to the app's database. The app chooses the database, opens it, and supplies an adapter through the server's `storage` option. The adapter owns the mapping between Tandem tuples and that database's records. A JSON file, an embedded database, and a database reached over the network can all serve as storage.

Tandem ships one adapter, `TandemServerJsonFileStorage`, which keeps every tuple in a single JSON file. Use it for development, tests, and examples. An app that stores real data will usually need its own adapter for the database it already runs, such as Postgres or SQLite. This page describes what that adapter must do.

## Connect storage

Implement `TandemServerStorageApi<YourSchema>` in your app, then pass that instance to the server:

```ts
import { TandemServer } from "@tanishqkancharla/tandem-server"
import type { TandemServerStorageApi } from "@tanishqkancharla/tandem-server"
import { schema, type TodoSchema } from "./schema"
import { openAppStorage } from "./storage"

// openAppStorage is app code that opens the database and returns its adapter.
const storage: TandemServerStorageApi<TodoSchema> = await openAppStorage()
const server = new TandemServer({ schema, relations: {}, storage })
```

Call `server.close()` on shutdown; it closes the supplied adapter. If the adapter borrows a database connection shared with other services, its `close` method should release its own resources and leave that connection's lifetime to the app.

## Implement the contract

The interface lives in [`TandemServerStorage.ts`](../packages/server/src/storage/TandemServerStorage.ts). Its types come from `@tanishqkancharla/tandem-server` and `tuple-database`:

```ts
import type { AnySchema } from "@tanishqkancharla/tandem-core"
import type { TandemTuple } from "@tanishqkancharla/tandem-server"
import type { ScanStorageArgs, WriteOps } from "tuple-database"

interface TandemServerStorageApi<Schema extends AnySchema> {
	scan(args?: ScanStorageArgs): Promise<TandemTuple<Schema>[]>
	commit(writes: WriteOps<TandemTuple<Schema>>): Promise<void>
	subscribe?(onChange: () => void): () => void
	close(): Promise<void>
}
```

### Read ordered tuples

`scan` returns key/value pairs in tuple-database's key order, honoring the requested bounds, direction, and limit. With no arguments it returns all tuples. Storage receives key ranges; the tuple database above it translates collection prefixes and individual key lookups into storage reads.

Preserve tuple ordering when mapping keys into a database index. tuple-database's `encodeTuple` (from `tuple-database/helpers/codec.js`) turns a key into a string whose JavaScript sort order matches tuple order. JavaScript compares strings by UTF-16 code units, so store the encoded key as UTF-16 big-endian bytes in a binary column and let the database compare bytes:

```ts
import { encodeTuple } from "tuple-database/helpers/codec.js"

const storedKey = Buffer.from(encodeTuple(key), "utf16le").swap16()
```

Storing the encoded string as UTF-8 text sorts emoji and other characters above U+FFFF differently, and text collations can reorder it further. Serializing a key with `JSON.stringify` does not preserve tuple order either. Compound IDs keep each ID part as a separate key part.

Store both record tuples and client metadata:

| Tuple                     | Key                                      | Value                 |
| ------------------------- | ---------------------------------------- | --------------------- |
| Record with a string ID   | `["record", "todos", "todo-1"]`          | The full todo record  |
| Record with a compound ID | `["record", "entries", "session-1", 42]` | The full entry record |
| Client acknowledgement    | `["client", clientId]`                   | `{ lastMutationId }`  |

The acknowledgement lets the server avoid running an accepted client mutation again. An adapter that stores only record tuples loses that protection after a restart.

### Commit a batch

`commit` receives `set` entries containing full keys and values, and `remove` entries containing keys. Either list can be absent. Replace existing values for set keys and allow removal of missing keys. If one batch both removes and sets a key, the set wins, as in tuple-database's `InMemoryTupleStorage`.

Apply the batch atomically, including record changes and client acknowledgements written together. Resolve only after the batch succeeds and subsequent reads can see it. A durable adapter must save the batch before resolving. Reject the promise on failure; the storage API does not return errors as values.

Tandem orders sync operations within one server instance. Several instances sharing storage still need database-level coordination; an atomic storage batch alone does not serialize their mutators' earlier reads.

### Report changes

`subscribe` is optional. When supported, invoke its callback after a commit becomes readable through `scan`, including writes from other processes if the database can report them. Duplicate notifications are allowed. Return a synchronous unsubscribe function, and do not await client pulls from the callback.

Notifications carry no changed keys or record values. Tandem sends bare pokes so connected clients pull again. Without storage notifications, an external write becomes visible on a later pull but does not trigger a poke. Writes committed through `TandemServer` already trigger its own poke handling.

## Where queries run

Tandem evaluates `where`, `orderBy`, `limit`, `offset`, and relation includes in JavaScript. A server query runs in the application server process. A client query runs against that client's local database.

For example, a pull whose window requests the newest 20 todos follows this path:

```text
Client sends its scan window
  -> Tandem loads the relevant collections through adapter.scan(...)
  -> The adapter reads tuples from the app's database
  -> Tandem filters, sorts, and chooses records in JavaScript
  -> The server sends the client's patch
```

The adapter receives no Tandem query object, predicates, or relation definitions. A SQL adapter can execute key-range reads, ordering, and scan limits in the database, but the current interface does not ask it to translate Tandem queries into SQL.

Currently, object queries and pull windows load whole relevant collections before evaluating their filters and pages. A query with `limit: 20` does not imply a storage read of only 20 tuples. Transaction `get` and `scan` calls can request individual keys or ID ranges directly. See [Queries](queries.md) for the public query API.

Efficient small queries need both a Tandem query executor that requests narrow reads and an adapter that can answer those reads cheaply. A database key index alone cannot speed up a collection-wide read followed by filtering in JavaScript. Secondary indexes and narrower object-query reads are not provided by the current executor.

## What stays in memory

Storage ownership and sync state are separate:

| Owner           | State                                                                                                                                                                |
| --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| App's database  | Records and persisted client acknowledgements                                                                                                                        |
| Storage adapter | Any cache it chooses to maintain; Tandem does not require a full in-memory copy                                                                                      |
| `TandemServer`  | Client connections, cookies, latest connected scan windows, IDs returned by the last pull, IDs sent in live pokes, buffered live changes, and recent write revisions |
| Query execution | Temporarily loaded collections, intermediate results, and the response                                                                                               |
| Client          | Its local records, pending mutations, and live updates; optional client storage persists local state                                                                 |

A pull reads records through the adapter. The IDs remembered from a previous pull help compute removals; they are not a stored copy of those records. Live pokes can instead send values from the commit that just happened. Simple filtered windows check the changed values directly, while windows with includes or pagination can read storage again to decide which changed records belong in the payload.

Server memory can still grow with collection sizes, the number of clients, records per client view, and buffered changes. Sync bookkeeping should not be assumed to have a fixed small size. Server cookies, windows, and revisions reset when the instance restarts; persisted mutation acknowledgements do not, when the adapter stores them durably.

The bundled JSON adapter reads and parses the entire file into temporary memory on every `scan` and `commit`, and rewrites the file on every commit. That cost grows with the file, which is one reason to keep it to development and tests.

## Validate an adapter

[`TandemServerJsonFileStorage`](../packages/server/src/storage/TandemServerJsonFileStorage.ts) is a short, complete adapter. Read it before writing your own.

Compare scans with tuple-database's `InMemoryTupleStorage` using the same tuples and arguments. Cover mixed key types, compound IDs, inclusive and exclusive bounds, reverse scans, limits, and empty results.

Also verify atomic commits, failures without partial writes, reads after commits, and records and mutation acknowledgements after reopening durable storage. If the adapter reports external writes, exercise two storage instances and check that notifications arrive only after the write is readable.

Finally, connect a real client to `TandemServer` using the adapter and exercise push, pull, reconnect, and mutation retry. The [server tests](../packages/server/test/TandemServer.spec.ts) show these consumer flows. See [Server limitations](server.md#limitations) before deploying several server instances.
