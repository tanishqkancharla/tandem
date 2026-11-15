# Phase 2: Number commits in the database

[Phase 1](06-durable-client-acks.md) made acknowledgements durable. This phase makes revisions durable and shared, so a client can take a live payload from one instance and a pull from another.

**Today**

A pull returns `revision: { server: instanceId, commit: commitCount }`, both in memory ([[packages/server/src/TandemServer.ts#TandemServer.revision]]). When a client's poke and its pull reach different instances, or the server restarts, the client drops the live text it was showing, because the revisions name different servers. Streamed text flickers back to its last pulled value until the next pull.

**Proposed**

Every commit bumps `tandem_revisions.revision` for its scope in the same transaction and reads back the new value. `Revision.server` becomes the scope name, so revisions from any instance compare.

```diff
 export type Revision = {
-	/** Identifies the server instance that numbered the commit. */
+	/** The data scope whose commits this counts, shared by every instance. */
 	server: string
 	commit: number
 }
```

The storage API grows one optional capability. Storage that lacks it, such as the JSON file adapter, keeps per-instance numbering, which is correct for a single process:

```ts
export interface TandemServerStorageApi<Schema extends AnySchema> {
	scan(args?: ScanStorageArgs): Promise<TandemTuple<Schema>[]>
	commit(writes: WriteOps<TandemTuple<Schema>>): Promise<void>
	/** Commits and bumps the scope's revision atomically. Returns the new revision. */
	commitRevision?(scope: string, writes: WriteOps<TandemTuple<Schema>>): Promise<number>
	subscribe?(onChange: () => void): () => void
	close(): Promise<void>
}
```

```callstack [commitTransaction]
 TandemServer.commitTransaction(tx, options) [[packages/server/src/TandemServer.ts#TandemServer.commitTransaction]]
 ├── previous = read before-images of written records
-├── hasWrites = tx.commit()
-├── commitCount += 1
+├── revision = storage.commitRevision ? commitRevision(scope, writes) : commit, then ++commitCount
 ├── changes = { revision, collections, appends }
 └── emitLivePokes(changes)
```

In SQL, the bump is two statements at the start of the batch, so the batch's row lock on `tandem_revisions` orders commits in a scope:

```sql
update tandem_revisions set revision = revision + 1 where scope = ?;
insert into tandem_revisions (scope, revision) select ?, 1
  where not exists (select 1 from tandem_revisions where scope = ?);
-- ... record and tandem_clients statements ...
select revision from tandem_revisions where scope = ?;
```

The host `commit` callback today returns nothing; it returns the last statement's rows instead so the adapter can read the revision. D1's `batch` and Kysely transactions both return per-statement results.

Append ordering also changes. `after` was the commit that last wrote the record, from the in-memory `lastWrites` map. With shared revisions, the server uses the commit's own revision minus one when the record is not in `lastWrites`. A client that has pulled that far applies the append; one that has not waits for its pull, as it does today for forgotten writes.

Tests: a server test runs two `TandemServer` instances over one SQL storage and checks that a client's live text survives a pull from the other instance. `dst/` gains a second server instance sharing storage, with pokes from one and pulls from the other.

```changes

```
