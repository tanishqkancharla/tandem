# Sync Engine

## What

Synchronizes a client's local database with a remote server: pushes local mutations, pulls server patches for the client's subscriptions, and keeps optimistic writes visible until the server acknowledges them.

## How to use

```typescript
// Configured automatically by TandemClient
const remote: RemoteApi<Schema> = {
	async push({ clientId, mutations }) {
		// Apply the mutations in id order
		return { ok: true }
	},
	async pull({ clientId, cookie, scanWindow }) {
		// lastMutationId: the last of this client's mutations applied, on every pull
		return { cookie, patch, lastMutationId }
	},
	async connect({ clientId, poke }) {
		// Call poke() when the client should pull, or poke({ revision, set, remove })
		// with records a commit changed in the client's view
		return async () => { /* unregister this client */ }
	},
}
```

## How it works

1. **Optimistic writes**: `TandemClient.commit` delegates to `SyncEngine.commit` when a remote is configured. `Database.commitMutation` commits application records, sparse bases, an ordered outbox entry, and the incremented replica counter in one in-memory tuple transaction. A rejected transaction changes none of them and consumes no mutation ID. Local-only clients commit records directly without pending state. With storage configured, commit awaits the checkpoint before queueing delivery; optimistic records remain immediately visible.
2. **Push**: `SyncEngine` copies pending mutations and client identity, then flushes storage before sending. This barrier covers newer mutations included in the snapshot, not just the commit that queued the push. It rechecks identity and connection after waiting. Neither success nor transport failure removes mutations; the initial commit promise still reports the push attempt, or rejects earlier if its checkpoint fails.
3. **Pull**: `SyncEngine` fetches a patch for the scan window, which the client's subscriptions build. TandemServer keeps its latest generated view and opaque cookie per client. A missing or mismatched cookie returns a successful `patch.reset` snapshot instead of a diff. View changes, including subscription changes, receive a new cookie. `Database.applyPull` commits the cookie with the patch and acknowledgement, then the pull waits for storage.
4. **Rebase**: `["record"]` contains application-visible records, including optimistic changes. `["base", collection, ...id]` stores the latest known server value (or explicit absence) and `lastWrittenBy` only for records touched by pending mutations. `["outbox", mutationId]` stores ordered operations. A pull updates records and tracked bases, prunes acknowledged mutations, restores tracked records, replays remaining operations, then removes fully acknowledged bases before committing once. Record writes participate in normal transaction conflict detection even when the final value is unchanged. Snapshot resends and replay can therefore invalidate open drafts without a new application mutation. `["replica"]` owns identity, counter, and cookie; `SyncEngine` reads them from the database.
5. **Clear**: explicit `clear()` discards records, bases, and the outbox in one in-memory transaction. It starts a new client identity with a reset counter and cookie, preserves connected/disconnected state, and ignores old-session pull responses and pushes still waiting for storage. Storage clear runs after active saves and supersedes queued old-session writes. Await clearing before starting new work. Already dispatched writes are not cancelled or undone on the server.
6. **Delivery**: each durable commit queues one push of the current pending snapshot. Failure rejects that commit promise but retains the mutation. A later commit includes older unacknowledged mutations; reconnect pulls first, then pushes anything still pending. Failed storage batches remain buffered before newer writes; explicit flush or later work can retry them. There is no automatic retry, backoff, or confirming-pull loop. Without another commit or reconnect, a lost request stays pending locally.
7. **Pokes**: the remote tells a client when to pull. TaskQueue coalesces queued pulls; a poke during an in-flight pull queues a subsequent pull. Only a pull acknowledgement removes pending mutations, not a successful push response.
8. **Live records**: a poke payload carries full records and removals with the server commit's revision. While connected and for the current identity, `Database.applyPoke` writes them as the record's server value in memory: it keeps the confirmed value as a base (`lastWrittenBy` 0 when no write is pending), writes the live value, and replays pending operations for those records. It skips records whose live value or latest pull already covers the revision (same `server`, commit at or below). `applyPull` drops live records at or below the pull's revision, or from another server, or all of them when the pull has no revision. It rebuilds tracked records from bases, writes the remaining live values over them, then replays the outbox; bases under remaining live values survive pruning. No delete, reset, or out-of-view special case is needed, because a retired live record falls back to its base. Live values reach client storage like other record writes, so hydration rebuilds each tracked record from its base and pending operations and drops bases without a pending writer. `clear()` drops the live map.
9. **Live appends**: a payload's `append` ops carry text a server `append` added to a record the client knows, with the field's previous length (`offset`) and a revision from which the record held the value it extends (`after`: TandemServer sends the commit that last wrote the record). `applyPoke` extends the record's server value (live value at its payload's revision, else base or record at the latest pull) only if that revision is at or after `after` and every offset matches, and shows the result as an ordinary live record. Anything else waits for the pull. Clients cannot append; replaying a non-idempotent op over a live value that may already contain it would duplicate text.

A confirmed write outside every subscription disappears on the next pull, because the server never sends that record back.

A reset clears application records and marks tracked bases absent before applying the snapshot, pruning acknowledged mutations, and replaying the remaining outbox. It does not discard unacknowledged mutations or change client identity. Startup restores every checkpoint namespace before resolving `ready`, accepting transactions, or connecting. The saved records already contain optimistic state; only pull reconciliation restores bases and replays remaining operations. Connection waits for hydration and checkpoint persistence, then pulls before pushing the restored outbox. Saved identity and mutation IDs survive restart, so server deduplication prevents retransmissions from overwriting later corrections. Automatic retries remain deferred.

Expected remote failures are JSON-safe values tagged by `error`: `mutation-gap` (push only, with expected/received IDs), `invalid-request`, and `unavailable`. Remote callers must narrow those responses before reading pull data or treating a push as successful. Transport adapters return `unavailable` for expected network failures. SyncEngine retains pending writes and rejects the public operation with the protocol response as its cause; a failed batch may still have committed a prefix. Unexpected exceptions can still reject.
