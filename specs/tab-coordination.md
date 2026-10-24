# Tab coordination with one server sync owner

Shared tabs keep a database in every tab for synchronous queries, transactions, and immediate local edits. One elected leader owns the persisted replica and the only server `SyncEngine`. Tabs talk to it with direct commands and receive complete views, instead of running a second sync engine against the leader. `SyncEngine.ts` is unchanged.

## Problem overview

Before this work, every tab ran a `SyncEngine` whose remote was `TabSession`. The leader owned another database and another `SyncEngine`, whose remote was the server. The tab-facing path duplicated mutation IDs, cookies, pushes, pulls, pokes, and reconciliation.

```callstack
-TandemClient.commit
-└── SyncEngine.commit # apply locally and schedule delivery to the leader
-    └── TabSession.push
-        └── TabHub.push
-            ├── SyncEngine.commit # schedule delivery to the server without awaiting it
-            └── Database.flushClientStorage # reply after local persistence
```

A tab's `commit()` therefore resolved after the leader's save, while a connected standalone client's `commit()` resolves after the server push response. Server updates reached a tab through poke, pull, and patch round trips across the channel.

## Solution overview

Keep leader election, the persisted replica, codecs, and the server `SyncEngine`. Each tab keeps its memory database, pending edits, subscriptions, connection wish, and outstanding requests. The leader answers writes and publishes views directly.

```mermaid
flowchart LR
    T[Tab database and pending edits] -->|commit, join, subscribe, connect| H[TabHub]
    H -->|saved, complete, views| T
    H --> D[Leader database and durable outbox]
    D --> S[Server SyncEngine]
    S -->|batched push and pull| R[Server]
    %% ref node:T [[packages/core/src/tabs/TabSession.ts#TabSession]]
    %% ref node:H [[packages/core/src/tabs/TabHub.ts#TabHub]]
    %% ref node:D [[packages/core/src/Database.ts#Database]]
    %% ref node:S [[packages/core/src/sync/SyncEngine.ts#SyncEngine]]
```

`commit()` keeps its standalone contract. It applies the edit synchronously. While the tab wants the server, it resolves after the server push response that carried the write, and rejects if that push fails. While the tab is deliberately offline, it resolves after the leader saves the write. `flushClientStorage()` waits for the leader save and never for the server.

```ts
const tx = client.transact()
tx.set("todos", todo)
const committed = client.commit(tx)

client.query({ collection: "todos" }) // already includes the edit
await client.flushClientStorage() // leader storage holds the edit
await committed // connected: the server accepted the push carrying it
```

## Goals

- Give server synchronization one owner and keep synchronous local reads and edits.
- Preserve `commit()` completion and failure semantics, and keep saving and other tabs independent of a stalled server push.
- Save a forwarded write and its deduplication receipt together, and apply each tab write to the server once.
- Preserve query coverage, codecs, readiness, and takeover behavior.
- Show correctness under lost replies, failed saves, reordered messages, and leader crashes with checks stronger than final convergence.

## Non-goals

- Change `SyncEngine`, server transports, conflict rules, or `clear()` semantics.
- Add a shared worker, automatic network retry timers, or delta views between tabs.
- Change the React bindings. `useTransaction` already flushes after `commit()`, as in a standalone client.

## Implementation

### ✅ Phase 1: Publish tab views from the leader

**Today**

The leader stored a cookie and sent-record map per tab, poked tabs after commits, and computed a pull patch when a tab asked.

**Proposed**

The leader publishes complete views. A view holds a revision, the session's scan-window records, and the session's last forwarded mutation. Tabs replace their base with it and replay their own pending edits.

```changes
ded3fdc
```

```changes
57071bc
```

`Database.applyPull` and the new `Database.applyTabView` share one reconciliation body. Only the server path writes a cookie.

```callstack
 Database.applyPull [[ded3fdc:packages/core/src/Database.ts#L446-L448]]
+└── Database.reconcile # replace confirmed records, prune acknowledged outbox, replay pending edits [[ded3fdc:packages/core/src/Database.ts#L461-L506]]
+Database.applyTabView # same reconciliation, no cookie [[ded3fdc:packages/core/src/Database.ts#L451-L459]]
```

`TabHub.publishViews` runs on a microtask-throttled queue after record changes. It captures every live session's view, flushes storage once, skips views unchanged since the last one sent to that session, and broadcasts identical views once with all their session IDs.

```ts
publishViews():
	views = sessions.map(captureView) // records and marker from one database state
	await flushClientStorage() // never show an acknowledgement the leader could lose
	for each group of identical views:
		post({ type: "view", sessionIds, view })
```

The join view restores the whole replica. Later views keep carrying restored records outside the tab's scan window, with current values, until the window covers them or they are deleted, so a narrower view does not remove them ([[57071bc:packages/core/src/tabs/TabHub.ts]]).

A tab ignores views with an older revision, so a delayed view cannot replace a newer one or erase a pending edit. It applies views from its current leader before the join reply arrives, because the leader does not resend a view it already published.

### ✅ Phase 2: Commit directly and complete on the server response

**Today**

A follower `SyncEngine` pushed to the leader, and the leader replied after saving.

**Proposed**

`TabSession.commit` applies the transaction to the memory database and sends the encoded mutation with `waitForServer`. The hub commits it once and answers twice: `saved` after a flush, `complete` after the server push response.

```changes
ded3fdc
```

```callstack
 TandemClient.commit [[ded3fdc:packages/core/src/TandemClient.ts#L281-L306]]
-└── SyncEngine.commit # follower engine with the leader as remote
+└── TabSession.commit # apply locally, then send the mutation [[ded3fdc:packages/core/src/tabs/TabSession.ts#L127-L137]]
+    └── TabHub.commit # one leader mutation per tab mutation [[ded3fdc:packages/core/src/tabs/TabHub.ts#L309-L372]]
+        ├── SyncEngine.commit(transaction, forwarded) # writes marker and receipt atomically
+        ├── Database.flushClientStorage # then reply "saved"
+        └── TabHub.awaitServer # then reply "complete" with the push result [[ded3fdc:packages/core/src/tabs/TabHub.ts#L387-L415]]
```

The receipt `["tab-write", tabClientId, tabMutationId]` maps a tab mutation to the leader mutation that carries it. A resend at or below the session marker finds the receipt instead of committing again.

The hub constructs its `SyncEngine` around a wrapper of the remote whose `push` records the response promise for each leader mutation a tab waits on. Completion never issues a second push for a write a push already carried.

```ts
awaitServer(mutationId, attempt):
	if no push carried it yet:
		await the leader connection // a failed connect completes offline
		if still uncarried and still in the outbox: await queuePush()
	await attempt.response // the latest push that carried it
	error response -> Remote push failed
```

The original commit can skip its push while the first connection is still pending, and a replacement leader inherits a mutation without its commit. Both wait for the connection and push once. The completion awaits the response promise, not a flag, because another push may already be in flight when the commit continues.

### ✅ Phase 3: Resend unsaved writes and recover takeover

**Today**

A failed leader save left the edit in the tab's outbox with no path to resend it.

**Proposed**

A session tracks the last mutation the leader saved, from `saved` replies and view markers. It resends outbox entries above that watermark that no request carries.

```changes
ded3fdc
```

```callstack
 TabSession.commit
+├── TabSession.retryWrites # older unsaved writes go first [[ded3fdc:packages/core/src/tabs/TabSession.ts#L263-L273]]
 └── TabSession.submit
+TabSession.flush # retry, then await every saved reply
+TabSession.connect # retry after the leader reconnects
+TabSession.join # queue retries, then resend in mutation order [[ded3fdc:packages/core/src/tabs/TabSession.ts#L356-L396]]
```

The tab retires a receipt with `finishWrite` only after a confirmed save, so a resend after a failed save or a takeover still finds it. Deterministic simulation found three takeover bugs, fixed here:

- A late `leader` announcement from a previous leader redirected a tab to it. A hub that sees a join addressed to another leader announces itself again.
- After a takeover, a tab resent newer pending writes before an older unsaved one. A leader without the tab's marker accepted the newer one first and dropped the older one. Rejoin now queues retries first and sends writes in mutation order.
- A failed rejoin left a tab unjoined forever. It now fails the requests waiting for it, which stay in the outbox, and the next request joins again.

The leader also watches each tab's lifetime lock, so a crashed tab's subscriptions, receipts, and connection wish are dropped without heartbeats.

### ⏳ Phase 4: Deterministic simulation of shared tabs

Validation, simulation, and the benchmark land in the next pull request of the stack.

## References

- [[packages/core/src/tabs/TabSession.ts]] — tab-side commands, retries, and views.
- [[packages/core/src/tabs/TabHub.ts]] — leader commands, push observation, and view publication.
- [[packages/core/src/tabs/TabProtocol.ts]] — messages and codecs.
- [[packages/core/src/Database.ts]] — receipts and shared reconciliation.
- [[packages/core/test/tabs.spec.ts]] — tab workflows.
- [[packages/core/src/tabs/AGENTS.md]] — current behavior and limits.
