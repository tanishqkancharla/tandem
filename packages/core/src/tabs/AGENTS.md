# Tabs

## What

Lets browser tabs share one persisted client replica. One tab leads: it owns the storage and the remote connection. Every tab keeps an in-memory replica and exchanges commands and views with the leader.

## How to use

```typescript
// Automatic in a browser document when clientStorage has a name and a remote is set
const client = new TandemClient({ schema, remote, clientStorage })

// Elsewhere (a worker, tests), pass the locks and channels explicitly
import { InMemoryTabs } from "@tanishqkancharla/tandem-core/internal"
const tabs = new InMemoryTabs()
const client = new TandemClient({
	schema,
	remote,
	clientStorage,
	tabs: { environment: tabs.openTab() },
})
await client.close() // saves, then hands leadership to another tab
```

## How it works

1. Election: `TabSession` requests a lock named `tandem:<storage name>`. The holder calls `lead`, which builds the persisted `Database` and a `TabHub`. The hub owns the leader's `SyncEngine` with the real remote. Other tabs stay queued for the lock and take over when it is released. Each tab also holds a lifetime lock, `tandem:<name>:tab:<id>`, so the leader learns when a tab ends without heartbeats.
2. Sessions: `TandemClient` keeps an in-memory `Database` with its own client ID. `TabSession` owns that tab's side of the protocol, not a `SyncEngine`. It joins the leader with its subscriptions and whether it wants the remote, and the join reply carries a complete view.
3. Commit: `TabSession.commit` applies the transaction to the in-memory replica synchronously, then sends the encoded mutation with `waitForServer` set to the tab's connection wish. `TabHub` commits it as one leader mutation through `SyncEngine.commit(transaction, forwarded)`, which writes the session marker `["session", clientId]` and the receipt `["tab-write", clientId, mutationId]` in the same tuple transaction. A mutation at or below the marker is a resend: the hub finds the receipt instead of committing again. A session without a marker starts at whatever it sends first; otherwise mutation IDs must follow the marker without gaps.
4. Responses: the hub answers twice. `saved` follows a storage flush and lets `flush` return without waiting for the remote. `complete` follows the remote push response when `waitForServer` is set. The hub wraps the remote's `push` to record the response promise for each leader mutation a tab waits on. If no push carried the mutation, because the original commit ran while disconnected or because this hub inherited the mutation from a crashed leader, the hub waits for its connection and pushes once. A failed connection completes the commit offline, as a standalone commit after a failed auto-connect does.
5. Retries: a session tracks the last mutation the leader saved, from `saved` responses and view watermarks. Outbox entries above it that no request carries are sent again before each commit, on `flush`, after `connect`, and after joining a leader. After a join, the session sends pending writes in mutation order. It retires a receipt with `finishWrite` only after a confirmed save, so a resend after a failed save or a takeover still finds it.
6. Views: the leader publishes a view after record changes, on a microtask-throttled queue. A view holds a revision, the session's scan-window records, and its marker. Views are flushed to storage first, skipped when unchanged since the last one sent to that session, and broadcast once for every session with an identical view. A session ignores older revisions and applies a view with `Database.applyTabView`, which replays its own pending edits over it. A session applies views from its current leader even before the join reply arrives, because the leader does not resend a view it has already published.
7. Readiness: a session's replica lives in memory, so its `Database` is ready before the leader has restored it. `ready` resolves after the first join, so it stays the restore barrier for `transact` and `clear`. A failed first join rejects `ready`. A later failed join fails the requests waiting for it, and the next request joins again.
8. Handoff: a new leader subscribes to every saved session window before it connects, so its first remote pull does not remove records the tabs still sync. Windows of sessions that do not join within a minute belong to closed tabs and are dropped. A late `leader` announcement from a previous leader can reach a tab after the new one; a hub that sees a join addressed to another leader announces itself again.
9. Connection: each tab tells the leader whether it wants the remote. The leader stays connected while any tab wants it. Every explicit connect schedules a pull followed by a push of remaining pending mutations. This work runs in the background so stalled sync does not block connection control. `autoConnect` sets a tab's initial wish. When a tab's lifetime lock is released, the hub forgets its subscriptions, receipts, and connection wish.
10. Codecs: records cross the channel by structured clone, so collection codecs encode values before sending and decode them on receipt. The client combines its schema codecs with `clientStorage.codecs`; storage codecs take precedence, including explicit IndexedDB overrides and codecs from a schema supplied only to storage. Custom storage adapters that supply codecs expose them through this optional metadata.
11. Timing: tab requests and views use the channel directly. The leader's `SyncEngine` and storage queue use `VisibilityAwareTimer`: their usual intervals while the page is visible, the next task while it is hidden, because browsers delay timers in hidden tabs but not messages.

## Limits

- Session markers that hold a mutation ID are never pruned.
- A frozen leader tab (paused entirely, not just throttled) answers nothing until it resumes. Chrome does not freeze tabs that hold a Web Lock; other browsers may.
- Coordination needs a storage name and an environment. Without them a client owns its storage alone, so custom storage shared by tabs must set `name`.
- `clear()` in one tab clears the leader's replica for every tab. Writes the clearing tab sent before its clear are reported as cleared; later ones land in the new replica. Other tabs keep their unsaved mutations and resend them, but a resend of a write the leader had already saved before the clear reports it as cleared. A `clear` pending when the leader changes fails rather than run twice.
- Views are complete snapshots of a session's scan window, so view size grows with the subscribed data. Unchanged views are skipped and identical ones shared.
- A tab's join restores every record. Views keep carrying restored records outside the tab's scan window, with current values, until the window covers them or they are deleted, so a narrowly subscribed tab receives the rest of the replica in each view.
- `dst/TabWorld.ts` simulates shared tabs deterministically; run it with `pnpm dst:run --tabs`.
