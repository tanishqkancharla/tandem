# Known failures

Runs the simulation found that fail because of sync engine bugs we have not fixed yet. Each file holds a run's `options` and its full `result`: the step-keyed trace, generated ids, and the final state of the server and every client.

`dst.spec.ts` checks every recording two ways. "reproduces every recorded known failure" reruns each one and requires an identical result, so a recording that no longer matches the simulation fails loudly and must be re-recorded. And each bug has a test marked `it.fails`, which starts failing once the bug is fixed; then delete the recording and drop `.fails`.

The four bugs are independent: applying the fix for A still leaves B, C, and D failing.

## A. An empty patch drops its acknowledgement: `seed-2-empty-patch-drops-ack.json`

`{ seed: 2, steps: 30 }`. At the end client2 is missing `item-2`, which the server has.

- client2 sets and then removes `item-2`; both pushes are applied, so the server's window is empty.
- client2's next pull returns `{ set: [], remove: [], ack }`, and the server consumes the ack.
- client1 later sets `item-2` again.

```
client.applyPatchAt:
  patch is empty → return        # before looking at the ack, so the remove stays speculative
later pulls:
  undo speculative, apply patch, replay speculative
                                 # the ack is gone, so the stale remove is replayed forever
```

Also reproduced through the public API by the `(known bug)` test in `packages/core/test/sync/conflicts.spec.ts`, where a lost poke lets a deleted write survive.

## B. The server does not count keys a client pushed: `seed-102-pushed-keys-not-synced.json`

`{ seed: 102, steps: 10 }`. At the end client2 still holds `item-3 (rev 1)`, which the server does not have.

- step 1: client2 creates `item-3`, and its push is applied. The server never sends `item-3` back to client2.
- step 9: client2 removes `item-3` itself.
- When client2 rebases over its acknowledged remove, undoing the remove restores the value it captured locally, `rev 1`.

```
server.pull:
  removes = syncedKeys - records   # syncedKeys holds only keys the server sent,
                                   # never keys the client pushed, so no remove follows
```

## C. A lost push response rolls back an accepted write: `seed-288-lost-response-rollback.json`

`{ seed: 288, steps: 10, faultRate: 0.1 }`. At the end client2 shows `item-3 (rev 0)` while the server and client1 have `rev 4`.

- steps 0 and 4: client2 writes `item-3` twice; both pushes are applied.
- step 9: the second push's response is dropped (`responseLost`).

```
push fails → rollback([rev 4 write])      # treats a lost response as a rejection, restores
                                          # the captured rev 0, and removes the accepted
                                          # mutation from speculativeMutations
next pull: { set: [item-3 rev 4], ack: <rev 4 mutation> }
  findIndex(ack) = -1                     # the acknowledged id is gone, so older writes
                                          # count as unacknowledged and are replayed
```

## D. A crash loses writes that were stored but not pushed: `seed-25-crash-loses-outbox.json`

`{ seed: 25, steps: 15, crashRate: 0.1 }`. At the end client2 shows `item-1 (rev 7)`, which the server never received.

- step 7: client2 writes `item-1`.
- step 10: client2's storage write for `item-1` is sent to `client2Storage`; its push has not been sent.
- step 12: client2 crashes. The storage write was already sent, so it still lands. The push never leaves.
- At quiescence, the run restarts client2 from storage with a new client id.

```
client storage persists:  materialized tuples only
not persisted:            pending mutations, speculative mutations, client id, cookie
restart:                  item-1 loads as if it were confirmed data, and no mutation
                          exists to push it, so it never reaches the server
```

Replicache and Triplit both persist their pending mutations for this reason.
