# Sync relational subscriptions through remote

## Problem overview

Local relational queries and subscriptions can now embed `with` results, but remote sync still treats subscriptions as flat collection scan windows. A subscribed client can miss remote child-collection changes because poke intersection only checks the root query collection, and pull does not explicitly guarantee that records required by included relations are returned for a newly subscribed relational scan window.

## Solution overview

Teach the remote sync path to treat an encoded relational query as a query tree. Pokes should recurse through included collections, and pulls should return a non-underfetching snapshot for every collection touched by the subscribed query tree so the local database has enough records to compute relation-expanded results and preserve optimistic replay behavior.

## Goals

- A client subscribed to a relational query receives remote updates when an included child or nested child collection changes.
- A pull for a relational scan window returns the records needed for the local database to compute the requested relation-expanded result.
- Existing flat subscription sync behavior remains unchanged.
- Optimistic rollback/replay still produces correct relation-expanded subscription results when a remote patch lands while local mutations are pending.

## Non-goals

- No migrations or backfills.
- Do not add a production server module; this spec updates the shared remote contract helpers and `TestRemote` behavior only.
- Do not implement precise join-aware remote filtering or authorization. Returning a superset of included-collection records is acceptable for this v1 as long as the client does not underfetch.
- Do not change the public object query API or result shape.

## Future work

- Add a production server module that evaluates scan windows with schema relations, tenant scoping, and resource caps.
- Tighten remote relation fetching to avoid broad included-collection overfetch once server-side relation execution exists.
- Add protocol-level validation for encoded query depth, limits, offsets, and relation names.

## Important files/docs/websites for implementation

- `README.md` - Relational Queries v2 roadmap item this spec implements.
- `docs/relational-queries-design.md` - Source of truth for object query shape, relation result semantics, and remote/security notes.
- `packages/types/src/types.ts` - Defines `EncodedQuery`, `ScanWindow`, `RemoteApi`, and current mutation/scan-window intersection helpers.
- `packages/core/src/query/Query.ts` - Encodes public relational query objects into nested `EncodedQuery.with` trees.
- `packages/core/src/sync/SyncEngine.ts` - Sends subscribed encoded queries as the remote pull scan window.
- `packages/core/src/TandemClient.ts` - Wires local relational subscriptions to `SyncEngine.subscribe` and applies remote patches with optimistic replay.
- `packages/testing/src/TestRemote.ts` - In-memory remote used by sync tests; this is where relation-aware pull/poke behavior should be exercised first.
- `packages/core/test/TandemClient.spec.ts` - Existing flat sync, local relational subscription, and optimistic replay coverage.

## Implementation

### Phase 1: Recurse scan-window intersection through included query trees

Make mutation intersection walk `EncodedQuery.with` recursively so a mutation in any included collection can poke subscribed clients. Keep the behavior intentionally collection-based for v1: if a query includes `messages`, any `messages` mutation intersects, even if a later server implementation can narrow this by relation joins.

```ts
function intersectsQuery(mutation: Mutation<Schema>, query: EncodedQuery<Schema>) {
	if (mutation.ops.some((op) => op.collection === query.collection)) return true

	return Object.values(query.with ?? {}).some((includedQuery) =>
		intersectsQuery(mutation, includedQuery),
	)
}
```

- [ ] Update `MutationApi.intersectsQuery` in `packages/types/src/types.ts` to recurse into `query.with`.
- [ ] Keep root flat-query intersection behavior unchanged.
- [ ] Add focused coverage that a mutation to an included collection intersects a scan window whose root collection is different.
- [ ] Add focused coverage that a mutation to an unrelated collection does not intersect the same scan window.
- [ ] Verify `pnpm --filter @tandem/types type-check` passes.

### Phase 2: Return a scan-window snapshot for root and included collections

Update `TestRemote.pull` so pulls are not only mutation-log deltas. For every encoded query in the scan window, return current records from the root collection and recursively included collections. This v1 may overfetch included collections, but it must not apply nested `limit`, `offset`, or `order` remotely because relation limits are applied per parent locally.

```ts
function collectSnapshotQueries(query: EncodedQuery<Schema>): EncodedQuery<Schema>[] {
	return [query, ...Object.values(query.with ?? {}).flatMap(collectSnapshotQueries)]
}

function buildSnapshotPatch(scanWindow: ScanWindow<Schema>) {
	return scanWindow.flatMap((query) =>
		collectSnapshotQueries(query).flatMap((snapshotQuery) =>
			selectCurrentRecords(snapshotQuery.collection, snapshotQuery.where),
		),
	)
}
```

- [ ] Store current remote record state in `packages/testing/src/TestRemote.ts` as mutations are pushed.
- [ ] Build pull `set` patches from current state for every root and nested included collection in the scan window.
- [ ] Apply `where` filters for each collection when building the snapshot, but ignore `select`, `order`, `limit`, and `offset` for snapshot fetching.
- [ ] Continue returning remove patches for removals since the caller's cookie so stale local records disappear.
- [ ] Add a test where a client connects, advances its cookie with an empty scan window, then subscribes to a relational query and still receives pre-existing remote parent and child records.
- [ ] Verify `pnpm --filter @tandem/core test` passes.

### Phase 3: Sync remote child changes into relational subscription results

Add end-to-end coverage proving that remote child and nested child mutations poke the subscribed client, pull into local storage, and re-emit relation-expanded parent rows. This phase should primarily be tests if Phase 1 and Phase 2 are sufficient.

```ts
client2.subscribe(
	{
		collection: "threads",
		select: { id: true },
		with: { messages: { select: { body: true }, orderBy: { createdAt: "asc" } } },
	},
	(result) => seenByClient2.push(result),
)
```

- [ ] Add a two-client test where client2 subscribes to `threads.with.messages`, client1 commits a new `messages` record, and client2's callback receives the updated embedded `messages` array.
- [ ] Add coverage for a nested included relation, e.g. `threads.with.owner.with.profile`, where a remote `profiles` update re-emits the subscribed thread result.
- [ ] Assert unrelated collection changes do not poke or re-emit the relational subscription.
- [ ] Verify the synced records are queryable directly on the subscribed client after the callback fires.
- [ ] Verify `pnpm --filter @tandem/core test` passes.

### Phase 4: Preserve optimistic replay with relation-expanded results

Add a regression test for the replay path that rolls back local speculative mutations, applies a remote patch containing included relation records, and reapplies the local mutations before relational subscribers observe the final result. The assertion should be on the relation-expanded query result, not on internal patch order.

```ts
const pendingCommit = client2.commit(localMessageEditTx)
await client1.commit(remoteMessageEditTx)

await vi.waitFor(() => {
	expect(client2.query(threadWithMessagesQuery)).toEqual(expectedRebasedRows)
})
```

- [ ] Add a delayed-push relational replay test modeled after the existing flat `replays a pending local edit on top of a newer remote patch` test.
- [ ] Ensure the pending local mutation can affect an included relation record, not only the root parent record.
- [ ] Assert the subscription callback and direct `client.query` both show the rebased relation-expanded result.
- [ ] Verify `pnpm --filter @tandem/core test` passes.
- [ ] Verify `pnpm type-check` passes.
