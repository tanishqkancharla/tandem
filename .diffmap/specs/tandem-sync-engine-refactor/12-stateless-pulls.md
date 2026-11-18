# Phase 6: Run TandemBackend without state between requests

[Phase 1](07-durable-client-acks.md) moved acknowledgements into the database, [Phase 2](08-remove-live-payloads.md) deleted revisions and live payloads, and [Phase 5](11-channels.md) moved subscriptions to the sync engine. Two things remain: each client's view, used for small pulls, and the run queue that keeps mutators serial. This phase replaces both, so any number of instances can serve one scope.

**Today**

Pull diffs depend on `syncClients[id].view` in memory, so a pull that reaches a new instance returns a full reset. Two instances writing one scope can lose updates, as [blocker 1](05-engineering-blockers.md#1-mutators-stop-being-serial) shows.

**Proposed**

A `views` option says where views live. Without one, every pull is a reset: correct, and cheap for small windows. With a memory store, a long-lived process keeps today's small pulls. With the SQL store, a serverless backend keeps them too, at one write per pull that changes the view. Commits run inside a database transaction that locks the scope's row in `tandem_scopes`, so instances serialize at the database instead of in a queue.

## View stores

```ts
export interface TandemViewStore {
	get(clientId: ClientId, cookie: Cookie): Promise<TandemView | undefined>
	set(clientId: ClientId, view: TandemView): Promise<void>
}

export type TandemView = {
	cookie: Cookie
	/** Record ID to fingerprint, as readPull builds today. */
	records: Map<string, RecordFingerprint | undefined>
}

export const memoryViews = (): TandemViewStore => /* today's syncClients view, bounded */
export const sqlViews = (sql: TandemSqlExecution): TandemViewStore => /* tandem_client_views */
```

```callstack [readPull]
 TandemBackend.readPull(args) [[packages/server/src/TandemServer.ts#TandemServer.readPull]]
-├── previous = cookie === client.cookie ? client.view : undefined
+├── previous = cookie ? await views?.get(clientId, cookie) : undefined
 ├── records = executeScanWindowAsync(...)
 ├── diff records against previous fingerprints
-├── client.view = view; client.cookie = nextCookie
+├── if view changed: await views?.set(clientId, { cookie: nextCookie, records })
 └── return { cookie, patch, ... }
```

A pull whose view did not change returns the same cookie and writes nothing, so an idle client's fallback pulls cost one read.

## Serial commits without the queue

Storage that supports interactive transactions gets a `transaction` method. The server runs each push mutation inside one:

```ts
export interface TandemBackendStorageApi<Schema extends AnySchema> {
	// ...scan, commit
	/** Runs fn in one database transaction that holds the scope's lock. */
	transaction?<T>(scope: string, fn: (tx: TandemStorageTransaction<Schema>) => Promise<T>): Promise<T>
}
```

```callstack [applyMutator with a storage transaction]
 TandemBackend.applyMutator(clientId, mutationId, call) [[packages/server/src/TandemServer.ts#TandemServer.applyMutator]]
+└── storage.transaction(scope, async (dbTx) =>
+    ├── select from tandem_scopes for update # takes the scope's lock first
+    ├── lastMutationId = read tandem_clients # now serial for this scope
+    ├── authorize and run the mutator against dbTx reads
+    ├── write records and tandem_clients
+    └── return ) # commit releases the lock
 publisher?.publish(...) # after the transaction commits
```

Where storage has no `transaction`, as with D1 and the JSON file, the backend keeps the run queue and documents that one process must own each scope, which is mode 1.

The `tuple-database` layer stays for query execution, but its in-process transaction no longer decides conflicts when storage provides `transaction`. Whether the backend reads through `AsyncTupleDatabase` inside a storage transaction, or calls `executeQueryAsync` on a thin read view of `dbTx`, is the main open design point in this phase; the second is simpler and drops a layer.

## What is left in memory

Only the publisher and an optional memory view store. `TandemBackend.subscribe` (server-side reactive queries) still sees only this instance's commits, and its docs say so.

Tests: the backend suite runs against a pool of three `TandemBackend` instances over PGlite, with requests spread at random. `dst/` adds a multi-instance backend mode with crashes mid-transaction and checks per-record histories against a serial model, not just convergence, so a lost update fails the run.

```changes

```
