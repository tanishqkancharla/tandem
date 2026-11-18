# Design questions, explained

The [cover](README.md#design-questions-to-confirm) lists thirteen design questions. This page draws each one: the recommendation beside its main alternative, so the trade is visible. It uses the pieces from [Target architecture](02-target-architecture.md): the client, `TandemBackend`, the sync engine, and the database.

## 1. How does a commit pick which clients to poke?

Something must match "what this commit changed" against "what each client watches" without running queries, since the sync engine has no schema or data. Both sides describe themselves with keys: a pull names the keys of its scan window, a commit names the keys of the records it wrote, and the sync engine pokes clients whose keys overlap.

```mermaid [Collection keys: every todos reader is poked]
flowchart LR
    c1["Commit: todo in workspace 42"] --> k1(["todos"])
    k1 --> a1["Client in workspace 42"]
    k1 --> b1["Client in workspace 7: pulls for nothing"]
```

```mermaid [Finer keys: only workspace 42 is poked]
flowchart LR
    c2["Commit: todo in workspace 42"] --> k2(["todos/workspaceId=42"])
    k2 --> a2["Client in workspace 42"]
    b2["Client in workspace 7, joined todos/workspaceId=7"]
```

Who writes the keys is the real question:

| Option | Who writes keys | Cost |
| --- | --- | --- |
| Collection keys only | Tandem: the collection name | Extra pokes and pulls in multi-tenant apps |
| Channel functions (the spec today) | The app: `channels.pull` and `channels.record` | A concept apps must learn, and must keep in step with their queries |
| Derived keys | Tandem: from a scan window's equality filters, and from a record's values for fields the schema marks, such as `workspaceId` | A new schema option, since schemas declare no indexes today; a filter on an unmarked field falls back to the collection key |

Recommendation: derived keys, kept inside Tandem, so apps see only "a publisher" and "a live transport". Channel functions can come later as an override. Either way, a key that is too coarse costs extra pulls, never missed changes.

## 2. Who serves pulls?

```mermaid [Recommended: the backend serves pulls]
flowchart LR
    rc["Client"] -->|"push, pull"| rb["TandemBackend: schema, permissions"]
    rb --> rd[("Database")]
    rb -->|"publish keys"| re["Sync engine: keys and connections only"]
    re -->|"poke"| rc
    rc -.->|"join keys from the pull"| re
```

```mermaid [Alternative: the sync engine serves pulls]
flowchart LR
    ac["Client"] -->|"push"| ab["TandemBackend"]
    ab --> ad[("Database")]
    ac -->|"pull"| ae["Sync engine: schema, permissions, storage"]
    ae --> ad
    ae -->|"poke"| ac
```

Recommendation: the backend. The sync engine then holds only keys and connections, so Ably, Pusher, or a small Durable Object can play the role. Serving pulls from the sync engine copies the schema, permissions, and database access into a second service.

## 3. How does the sync engine learn about commits?

```mermaid [Recommended: the backend publishes; a change feed is optional]
flowchart LR
    rb["TandemBackend"] -->|"commit"| rd[("Database")]
    rb -->|"publish keys"| re["Sync engine"]
    rj["Background job"] -->|"raw SQL write"| rd
    rd -.->|"optional change feed"| re
```

```mermaid [Alternative: a change feed only]
flowchart LR
    ab["TandemBackend"] -->|"commit"| ad[("Postgres")]
    aj["Background job"] -->|"raw SQL write"| ad
    ad -->|"change feed"| ae["Sync engine"]
```

Recommendation: publish from the backend, which works on every database, and add the change feed for apps that write outside Tandem. A feed-only design catches every write but only works on Postgres.

## 4. Is a lost publish acceptable?

The commit and the publish are two steps. A crash between them leaves a committed change that nobody is poked about.

```mermaid [A lost publish waits for the fallback pull]
sequenceDiagram
    participant B as TandemBackend
    participant D as Database
    participant E as Sync engine
    participant C as Other client
    B->>D: commit
    Note over B: crash before publish
    Note over C: up to 60 s later
    C->>B: fallback pull
    B-->>C: the change
```

```mermaid [Alternative: a transactional outbox]
sequenceDiagram
    participant B as TandemBackend
    participant D as Database
    participant R as Outbox relay
    participant E as Sync engine
    B->>D: commit records and an outbox row together
    R->>D: read new outbox rows
    R->>E: publish
    R->>D: delete sent rows
```

Recommendation: accept the delay. Crashes are rare, the fallback pull repairs them, and the change feed from question 3 closes the gap for apps that need it. The outbox adds a table, a relay process, and cleanup.

## 5. How do several backend instances keep mutators serial?

Today one process runs one mutator at a time per scope. With several stateless instances, two mutators can read the same rows at once.

```mermaid [Lock the scope row]
sequenceDiagram
    participant A as Instance A
    participant D as Database
    participant B as Instance B
    A->>D: begin, lock tandem_scopes row
    B->>D: begin, lock tandem_scopes row
    Note over B,D: waits
    A->>D: run mutator, commit
    D-->>B: lock granted
    B->>D: run mutator on A's result, commit
```

```mermaid [Alternative: optimistic commit with retry]
sequenceDiagram
    participant A as Instance A
    participant D as Database
    participant B as Instance B
    A->>D: read scope version 7
    B->>D: read scope version 7
    A->>D: commit batch if version is 7, set 8
    B->>D: commit batch if version is 7
    D-->>B: rejected, version is 8
    B->>D: rerun mutator from version 8
```

Recommendation: lock the row where the database has interactive transactions (Postgres, SQLite in a Durable Object), and run a single writer where it does not. Optimistic retry also works on D1, which is batch-only, at the cost of a version column and reruns under contention.

## 6. How do stateless pulls stay small?

Today the server keeps each client's last view in memory and returns a diff. A stateless backend has no memory between requests.

```mermaid [Recommended first: resets]
flowchart LR
    rc["Client: pull"] --> rb["TandemBackend"]
    rb -->|"read the scan window"| rd[("Records")]
    rb -->|"every record in the window"| rc
```

```mermaid [Optional: a view table]
flowchart LR
    oc["Client: pull"] --> ob["TandemBackend"]
    ob -->|"read the scan window"| od[("Records")]
    ob <-->|"read and update the last view"| ov[("tandem_client_views")]
    ob -->|"only what changed"| oc
```

Recommendation: ship resets first, since they need no new table and are correct by construction, then add the view table for apps with large windows. Requiring the view table from the start adds a write to every pull.

## 7. How do clients prove to the sync engine what they may join?

Without a check, any client could join any key and learn when another workspace changes.

```mermaid [Recommended: a signed grant]
flowchart LR
    rc["Client"] -->|"pull"| rb["TandemBackend: signs keys and expiry"]
    rb -->|"patch and grant"| rc
    rc -->|"join with grant"| re["Sync engine: checks the signature"]
```

```mermaid [Alternative: the sync engine asks the backend]
flowchart LR
    ac["Client"] -->|"join keys"| ae["Sync engine"]
    ae -->|"may this client join?"| ab["TandemBackend"]
    ab -->|"yes or no"| ae
```

Recommendation: a short-lived grant signed with a secret both sides share, so Tandem's sync engine checks it without a network call. Ably accepts the same shape, a token listing the channels a client may join. Pusher uses the call-back shape instead, so its adapter serves Pusher's auth endpoint from the backend. A call back on every join needs the backend reachable from the sync engine and adds a request per join.

## 8. What covers a commit that lands while a client joins?

The backend reads the window, then the client joins the window's keys. A commit between the two is published before the client listens.

```mermaid [The gap, closed by a second pull]
sequenceDiagram
    participant C as Client
    participant B as TandemBackend
    participant E as Sync engine
    participant O as Other client
    C->>B: pull
    B-->>C: patch, grant for workspace 42
    O->>B: push to workspace 42
    B->>E: publish workspace 42
    Note over E: client not joined yet, nobody poked
    C->>E: join workspace 42
    E-->>C: joined
    C->>B: pull again, because keys were added
    B-->>C: the other client's change
```

The alternative keeps recent publishes for a few seconds and replays them to a client that joins. Ably can do this with channel rewind, but Pusher cannot, and Tandem's sync engine would have to keep history. Recommendation: the second pull, which works the same with every sync engine. It costs one request only when a client's keys grow, and usually returns nothing.

## 9. Is one client per Durable Object room acceptable?

A client numbers its mutations in one sequence for one remote, and a server rejects a mutation whose number skips ahead. So one client cannot spread its mutations over several rooms.

```mermaid [Recommended: one client per room]
flowchart LR
    rp["Page showing rooms A and B"] --> rca["TandemClient A"]
    rp --> rcb["TandemClient B"]
    rca --> rda["Room A object: TandemServer"]
    rcb --> rdb["Room B object: TandemServer"]
```

```mermaid [Alternative: one client, several remotes]
flowchart LR
    ap["Page showing rooms A and B"] --> ac["TandemClient: a mutation sequence per remote"]
    ac --> ada["Room A object"]
    ac --> adb["Room B object"]
```

Recommendation: one client per room, which works with no core changes. One client with several remotes needs per-remote outboxes and sequences, and a rule for a mutation that touches two rooms.

## 10. Which Postgres change feed ships first?

```mermaid [Recommended first: triggers with NOTIFY]
flowchart LR
    rw["Any write"] --> rt["Trigger on each mapped table"]
    rt -->|"NOTIFY"| re["Sync engine"]
    rx["Sync engine down: notifications are lost"]
```

```mermaid [Later: logical replication]
flowchart LR
    aw["Any write"] --> al[("Write-ahead log")]
    al --> as["Replication slot"]
    as --> ae["Sync engine"]
    ae <-->|"saves its position"| ap[("tandem_feed_positions")]
```

Recommendation: triggers first. They work on every hosted Postgres with ordinary permissions, and a lost notification only delays clients until their fallback pull. Logical replication resumes after downtime but needs a replication role, and an abandoned slot keeps log files until the disk fills.

## 11. What happens to `TandemServer.subscribe`?

`subscribe` runs a query on the server and reruns it after commits. It only sees commits from its own process.

```mermaid [Recommended: TandemServer only]
flowchart LR
    rs["TandemServer: one process"] -->|"its own commits"| rq["subscribe callback"]
```

```mermaid [Alternative: fed from the sync engine]
flowchart LR
    ab1["Backend instance 1"] -->|"publish"| ae["Sync engine"]
    ab2["Backend instance 2"] -->|"publish"| ae
    ae -->|"poke"| aq["subscribe: rerun the query"]
```

Recommendation: keep it on `TandemServer`, where one process sees every commit, and leave it off `TandemBackend`. Feeding it from the sync engine makes the backend a sync engine client, which can come later if an app needs it.

## 12. Kysely or fumadb for the metadata tables?

```mermaid [Recommended: Kysely]
flowchart LR
    rs["tandem-backend/sql"] --> rk["kysely: already a dependency"]
```

```mermaid [Alternative: fumadb]
flowchart LR
    as["tandem-backend/sql"] --> ak["kysely"]
    as --> af["fumadb"]
    af --> az["zod"]
    af --> ac["commander"]
    af --> acl["clack"]
```

Recommendation: Kysely. The SQL storage already depends on it, and four metadata tables do not need fumadb's schema and migration layer.

## 13. What are the packages?

```mermaid [Recommended: one package per class]
flowchart LR
    rserver["tandem-server: TandemServer"] --> rbackend["tandem-backend: TandemBackend"]
    rserver --> rsync["tandem-sync: TandemSyncEngine"]
    rbackend --> rcore["tandem-core"]
    rsync --> rcore
```

```mermaid [Alternative: one server package]
flowchart LR
    aserver["tandem-server"] --> asub1["tandem-server/sync"]
    aserver --> acore["tandem-core"]
```

Recommendation: three packages, so a standalone sync engine installs no storage code and a serverless backend installs no connection code. One package with subpaths is simpler to publish but puts storage and connection dependencies in every install.
