# How Tandem syncs today

This page maps the current code that the [cover](README.md) proposes to split: how a client pushes and pulls, how the server processes mutations, how pokes reach clients, what the database holds, and which integrations exist.

## One write, end to end

A client commits locally, pushes, and waits for a pull to acknowledge the mutation. Every other connected client that reads the changed collection gets a poke and pulls too.

```services
service Alice "Alice's client"
  > TandemClient with its SyncEngine, which owns push, pull, and connect.
  state outbox = empty
  state todos = 1 row
service Server "TandemServer process"
  > One long-lived instance per data scope.
  service Queue "run queue"
    > Serializes every push, pull, and commit in this process.
  service Clients "syncClients map"
    > Per client: poke callbacks, cookie, view fingerprints, read dependencies.
    state alice = view of 1 row
    state bob = view of 1 row
  state commitCount = 7
service DB "Storage (D1, Postgres, MySQL, JSON file)"
  state todos = 1 row
  state clientAcks = alice: 4
service Bob "Bob's client"
  state todos = 1 row

start "Alice adds a todo and Bob sees it"
  > The server runs the mutation, writes the record and Alice's acknowledgement together, then pokes every connected client whose last pull read todos. Both clients pull to see the change.

step "Alice commits locally"
  Alice.todos = 2 rows (1 pending)
  Alice.outbox = mutation 5
step "Alice pushes mutation 5"
  Alice -> Queue: push(alice, [5])
step "The server runs the mutator and commits"
  Queue -> DB: commit(record, client alice = 5)
    > One storage commit holds the record writes and the acknowledgement.
  DB.todos = 2 rows
  DB.clientAcks = alice: 5
  Server.commitCount = 8
step "The server pokes clients that read todos"
  Clients -> Alice: poke()
  Clients -> Bob: poke()
    > Over each client's server-sent event stream. Alice is poked because she pushed.
step "Both clients pull"
  Alice -> Queue: pull(cookie, scanWindow)
  Bob -> Queue: pull(cookie, scanWindow)
  Clients.alice = view of 2 rows
  Clients.bob = view of 2 rows
step "Each pull returns a diff against that client's view"
  Queue -> Alice: patch, lastMutationId 5, revision 8
  Queue -> Bob: patch, revision 8
  Alice.outbox = empty
  Alice.todos = 2 rows
  Bob.todos = 2 rows
```

## Push

[[packages/server/src/TandemServer.ts#TandemServer.push]] runs inside the run queue, so one instance never processes two requests at once. For each mutation it reads the client's last acknowledged ID, skips duplicates, and rejects gaps:

```callstack [Push today]
 response = TandemServer.push({ clientId, mutations }) [[packages/server/src/TandemServer.ts#TandemServer.push]]
 └── run(applyPush) # one at a time per instance [[packages/server/src/TandemServer.ts#TandemServer.run]]
     ├── lastMutationId = readLastMutationId(clientId) # reads ["client", clientId] [[packages/server/src/TandemServer.ts#TandemServer.readLastMutationId]]
     ├── applyMutator(clientId, id, call) # named mutation [[packages/server/src/TandemServer.ts#TandemServer.applyMutator]]
     │   ├── authorize(tx, args, ctx), then run(tx, args, ctx)
     │   ├── acknowledge(id) # stages ["client", clientId] = id in the same transaction
     │   └── commitTransaction(tx) [[packages/server/src/TandemServer.ts#TandemServer.commitTransaction]]
     │       ├── tx.commit() # one storage commit
     │       ├── commitCount += 1 # per-instance revision
     │       ├── deriveAppends(writes, previous) # text-only changes [[packages/server/src/TandemServer.ts#TandemServer.deriveAppends]]
     │       └── emitLivePokes(changes) [[packages/server/src/TandemServer.ts#TandemServer.emitLivePokes]]
     └── return { ok: true, rejected? }
```

Mutators read and write through a `tuple-database` transaction ([[packages/server/src/TandemServerTransaction.ts#TandemServerTransaction]]). That transaction detects conflicts only inside one process. Correctness across concurrent mutators comes from the run queue, not the database.

## Pull

[[packages/server/src/TandemServer.ts#TandemServer.readPull]] reads every record the client's scan window covers, fingerprints each one, and compares with the view it stored for the client's cookie:

```callstack [Pull today]
 response = TandemServer.pull({ clientId, cookie, scanWindow }) [[packages/server/src/TandemServer.ts#TandemServer.pull]]
 └── run(readPull) [[packages/server/src/TandemServer.ts#TandemServer.readPull]]
     ├── lastMutationId = readLastMutationId(clientId)
     ├── previous = cookie === client.cookie ? client.view : undefined # memory only
     ├── records = executeScanWindowAsync(recordDb, relations, scanWindow) [[packages/core/src/query/executeQuery.ts#executeScanWindowAsync]]
     ├── dependencies = scanWindowDependencies(scanWindow) # only while connected [[packages/core/src/query/executeQuery.ts#scanWindowDependencies]]
     ├── for each record: recordFingerprint(value), keep it if new or changed [[packages/server/src/recordFingerprint.ts#recordFingerprint]]
     ├── client.view = view; client.cookie = new cookie
     └── return { cookie, patch, lastMutationId, revision: { server: instanceId, commit } }
```

A pull with an unknown cookie gets a full snapshot with `reset`. That includes every pull after a restart and every pull that reaches a different instance.

## Live event stream

The event stream is a poke channel, not a data channel. [[packages/server/src/TandemEventStream.ts#createTandemEventStreamResponse]] registers a poke callback with `remote.connect` and writes server-sent events: `ready` once registered, `poke` with an empty body or a JSON payload, and a keep-alive comment every 15 seconds. A slow reader collapses to one pending bare poke.

On the client, [[packages/core/src/sync/TandemEventSource.ts#connectTandemEventSource]] opens an `EventSource`, pulls on every `ready` (so a reconnect catches up), applies payloads, and pulls on a fallback timer every 60 seconds.

The server decides whom to poke in [[packages/server/src/TandemServer.ts#TandemServer.emitLivePokes]]:

- A client whose last pull read none of the changed collections is not poked, unless it pushed the commit.
- A commit that only appended text to string fields, which no query filters, orders, or joins on, goes out as a live payload ([[packages/server/src/LivePayloadBuffer.ts#LivePayloadBuffer]]), throttled to one per `livePokeInterval` (50 ms) per client. This is what makes streamed agent text appear before the pull.
- Anything else is a bare poke.

Storage may also report external writes through `subscribe` ([[packages/server/src/storage/TandemServerStorage.ts#TandemServerStorageApi]]); the server then bare-pokes every client. No shipped SQL adapter implements it.

## State the server keeps

| State | Where | Lost on restart or across instances? |
| --- | --- | --- |
| Records | Storage, as `["record", collection, ...id]` | No |
| Client acknowledgements, `["client", clientId]` → `lastMutationId` | Storage for JSON file and memory; **memory** in `TandemServerSqlStorage` | Yes for SQL adapters |
| Commit counter and `instanceId` (revisions) | Memory | Yes |
| Per-client cookie, view fingerprints, read dependencies | Memory (`syncClients`) | Yes |
| Live connections and poke callbacks | Memory | Yes |
| Last write per record (for append ordering) | Memory (`lastWrites`, 10,000 records) | Yes |

The SQL adapter's own comment states the acknowledgement gap: "Client acknowledgements are instance-local: this adapter does not yet support restart-safe retries" ([[packages/server/src/storage/TandemServerSqlStorage.ts#TandemServerSqlStorage]]). After a restart, a retried push re-applies mutations the database already holds. [[TODO.md]] lists persisting revisions, acknowledgements, scan windows, and synced record keys as follow-up work.

## Storage and SQL

[[packages/server/src/storage/TandemServerStorage.ts#TandemServerStorageApi]] is `scan`, `commit`, an optional `subscribe`, and `close`. `TandemServer` wraps it in a `tuple-database` `AsyncTupleDatabase`.

`@tanishqkancharla/tandem-server/sql` ([[packages/server/src/sql.ts]]) maps collections onto existing tables. [[packages/server/src/storage/TandemServerSqlStorage.ts#TandemServerSqlStorage]] compiles SQL with Kysely's query compilers for SQLite, Postgres, and MySQL, over a `DummyDriver`; the host supplies `query` and an atomic `commit`. Wrappers bind D1 ([[packages/server/src/storage/TandemServerD1Storage.ts#TandemServerD1Storage]]), node-postgres ([[packages/server/src/storage/TandemServerPostgresStorage.ts#TandemServerPostgresStorage]]), and mysql2 through [[packages/server/src/storage/kyselyToTandemSqlExecution.ts#kyselyToTandemSqlExecution]]. Two properties matter for this plan:

- `scan` reads a whole table, or rows matching an ID prefix, and filters in memory. Every pull reads every row of every collection its window touches.
- `commit` is one batch of statements. There is no interactive transaction, so a mutator's reads and the final writes are not in one database transaction.

## Integrations

- **Cloudflare** ([[examples/cloudflare/apps/server/src/index.ts]]): a Worker forwards every request to one Durable Object, `SyncObject`, which owns a `TandemServer` over D1 and serves both `POST /api/tandem` and the event stream. The browser remote ([[examples/cloudflare/apps/server/src/remote.ts#createRemote]]) pokes its own client after a successful push, so the pusher pulls its acknowledgement even when its stream is down.
- **Todo** ([[examples/todo/apps/server/src/app.ts#createTodoApp]]): a Hono server with JSON file storage and the same two routes; [[examples/todo/apps/web/src/TodoHttpRemote.ts#TodoHttpRemote]] is the browser remote.
- **Existing API servers** ([[docs/existing-api-server.md]]): mount the routes in an app's own server, with one instance per data scope.
- **Tabs**: in a browser, only the leader tab holds the remote connection ([[packages/core/src/TandemClient.ts#TandemClient]]), so a sync engine sees one connection per browser profile, not per tab.
