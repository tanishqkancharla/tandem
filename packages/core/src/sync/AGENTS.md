# Sync Engine

## What

Synchronizes a client's local database with a remote server: pushes local mutations, pulls server patches for the client's subscriptions, and keeps optimistic writes visible until the server acknowledges them.

## How to use

```typescript
// Configured automatically by TandemClient
const remote: RemoteApi<Schema> = {
	async push({ clientId, mutations }) {
		// Apply the mutations in id order
	},
	async pull({ clientId, cookie, scanWindow }) {
		// lastMutationId: the last of this client's mutations applied, on every pull
		return { cookie, patch, lastMutationId }
	},
	async connect({ clientId, poke }) {
		// Call poke() when the client should pull
	},
}
```

## How it works

1. **Optimistic writes**: `TandemClient.commit` delegates to `SyncEngine.commit` when a remote is configured. The engine commits locally, tracks the mutation, and advances its per-client counter (1, 2, 3, …) only after local success. Local-only clients commit directly to the database.
2. **Push**: `SyncEngine` sends queued mutations to the remote.
3. **Pull**: `SyncEngine` fetches a patch for the scan window, which the client's subscriptions build.
4. **Rebuild**: `SyncEngine` privately owns `PendingWrites`, which keeps pending mutations and the base, the server's latest value for each record they write. The engine borrows the client's database and opens the reconciliation transaction itself. A pull updates the base from the patch, drops mutations up to `lastMutationId`, resets those records to their base values, and replays the rest in order. Nothing is undone, so mutations carry no undo values.
5. **Rollback**: a failed push drops its mutations and rebuilds their records from the base.
6. **Pokes**: the remote tells a client when to pull.

A confirmed write outside every subscription disappears on the next pull, because the server never sends that record back.
