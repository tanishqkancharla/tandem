# Phase 3: Move per-client poke rules to the client

[Phase 2](07-database-revisions.md) made revisions shared. Two rules in [[packages/server/src/TandemServer.ts#TandemServer.emitLivePokes]] still need the server to know each client: poke the pusher, and send an append only to a client whose view makes it safe. A channel fan-out cannot apply either rule, so this phase moves both into the client, which already has the facts.

**Today**

After a push, the client waits for a poke before pulling its acknowledgement. If its event stream is down, the mutation stays pending in the UI until the fallback pull, unless the app's remote pokes itself, as the Cloudflare example does ([[examples/cloudflare/apps/server/src/remote.ts#createRemote]]). Live appends reach only clients whose server-side view passed [[packages/server/src/TandemServer.ts#TandemServer.liveAppends]].

**Proposed**

The client pulls right after a successful push, so its pending mutation clears whether or not any sync engine is connected. The server sends the same append payload to every client in the channel, and each client decides whether it can show it.

## Pull after push

```callstack [SyncEngine.push]
 SyncEngine.push() [[packages/core/src/sync/SyncEngine.ts#SyncEngine.push]]
 ├── response = remote.push({ mutations, clientId })
 ├── record rejections
+└── if response.ok: queuePull() # acknowledge without waiting for a poke
```

`TaskQueue` already coalesces a pull queued during another pull, so a poke that arrives as well costs nothing extra. The server's pusher branch in `emitLivePokes`, and the self-poke in both example remotes, go away.

## Client-side append checks

The server's check has three parts. The client can answer each from its own state:

| Server check today | Client check |
| --- | --- |
| The client's view has the record at the value before the commit (fingerprint match) | `Database.applyPoke` already checks the append's `offset` against the record's server value and its `after` revision ([[packages/core/src/Database.ts#Database.applyPoke]]) |
| No query filters, orders, or joins on the appended field | `scanWindowDependencies` of the client's own window; skip the append if the field is a membership field ([[packages/core/src/query/executeQuery.ts#scanWindowDependencies]]) |
| No bare poke since the last pull invalidated a collection that shifts this one's membership | The client tracks collections poked since its last pull, from the payload's channels |

```callstack [Database.applyPoke]
 Database.applyPoke(payload) [[packages/core/src/Database.ts#Database.applyPoke]]
+├── dependencies = scanWindowDependencies(current window) # cached per window
+├── for each append:
+│   ├── if append.field in dependencies.membershipFields(collection): skip, wait for pull
+│   └── if an invalidated collection shifts this collection: skip, wait for pull
 ├── if record's server value is older than append.after or offset differs: skip
 └── apply as a live record, replay pending writes
```

The server keeps deriving appends per commit ([[packages/server/src/TandemServer.ts#TandemServer.deriveAppends]]) but stops filtering per client. `client.live`, `client.invalidated`, and the per-client view comparison leave `SyncClientState`.

Tests: the live append tests ([[packages/server/test/Append.spec.ts]], [[packages/server/test/LivePokes.spec.ts]]) keep their expectations; the cases where the server withheld an append now assert that the client skips it. A core test pushes with no live connection and checks the mutation clears. `dst/` adds a run with the event stream disconnected that asserts pending mutations clear within one push round trip.

```changes

```
