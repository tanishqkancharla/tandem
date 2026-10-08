# Known failures

No recorded failures remain here. The fixed cases below live in `dst/regressions/`. Each JSONL artifact preserves run options, scheduled events, and the original outcome. Random runs execute every requested step before checking convergence at `quiescence`.

Settlement disables faults, drains calls, restarts crashed clients from storage, reconnects every client to resend retained writes, drains again, and pulls every client. All clients subscribe to the entire `todos` collection, so each final view must equal the server's state.

`dst.spec.ts` replays regression artifacts without random choices and requires convergence. New known failures should assert their recorded violation until fixed, then move to the successful regressions. Boundary divergence instead means the recording needs investigation before it can test the bug again.

The server is authoritative. DST does not require every historical mutation to reach it, including writes lost from memory on a crash. It still rejects ghost local records absent from the server after final pulls. Protocol tests separately cover mutation ordering and deduplication.

## Fixed: a lost push request

`dst/regressions/lost-push.jsonl` preserves the original six-event reproduction: client1 writes `item-3`, then its push request is dropped. The sync engine now retains that mutation. Settlement reconnects the client, delivers the write, and pulls both clients into agreement with the server. No automatic retry or persistence is required for this case.

## Fixed: a ghost record survives restart

`dst/regressions/crash-ghost.jsonl`, recorded with `{ seed: 13, steps: 15, crashRate: 0.1 }`, preserves the original failing trace and outcome. It now replays without a convergence violation: the first pull without a cookie resets the cached view to the server's subscribed records, removing `item-2 (rev 5)`.

- step 5: client2 writes `item-2`, and the write reaches its storage; the push does not reach the server.
- step 12: client2 crashes.
- At quiescence, the run restarts client2 from storage with a new client id.

```text
client storage persists:  materialized tuples only
not persisted:            pending mutations, speculative mutations, client id, cookie
restart:                  item-2 loads as if it were confirmed data, and no mutation
                          exists to push it, so it never reaches the server
```

The failure was not that the write was lost. The failure was that final pulls left the client's view different from the server. The reset removes the ghost record without introducing a durable outbox. Pending writes still in memory are replayed over the reset snapshot.

## Fixed: a lost pull response loses removals

The server retains the latest generated view and its opaque cookie per client. Missing or mismatched cookies receive an authoritative reset, so retrying after a lost removal response cannot silently omit the deletion. Subscription changes receive a new cookie even without a database revision change. `dst.spec.ts` checks fault seed 10 and crash/fault seed 7 at 300 steps against the server after settlement.
