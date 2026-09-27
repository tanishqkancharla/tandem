# Known failures

Runs the simulation found that fail because of sync engine bugs we have not fixed yet. Each file holds a run's `options` and its full `result`: the step-keyed trace, generated ids, and the final state of the server and every client.

`dst.spec.ts` checks every recording two ways. "reproduces every recorded known failure" reruns each one and requires an identical result, so a recording that no longer matches the simulation fails loudly and must be re-recorded. And each bug has a test marked `it.fails`, which starts failing once the bug is fixed; then delete the recording and drop `.fails`.

The three bugs are independent: applying the fix for A still leaves B and C failing.

## A. An empty patch drops its acknowledgement: `seed-2-empty-patch-drops-ack.json`

`{ seed: 2, steps: 30 }`, no faults. At the end client2 is missing `item-2`, which the server has.

- steps 0 and 2: client2 sets and then removes `item-2`; both pushes are applied, so the server's window is empty.
- client2's next pull returns `{ set: [], remove: [], ack }`. The ack is consumed on the server.
- step 28: client1 sets `item-2` again.

```
client.applyPatchAt:
  patch is empty → return        # before looking at the ack, so the remove stays speculative
later pulls:
  undo speculative, apply patch, replay speculative
                                 # the ack is gone, so the stale remove is replayed forever
```

Also reproduced through the public API by the `(known bug)` test in `packages/core/test/sync/conflicts.spec.ts`, where a lost poke lets a deleted write survive.

## B. The server does not count keys a client pushed: `seed-84-pushed-keys-not-synced.json`

`{ seed: 84, steps: 20 }`, no faults. At the end client2 still holds `item-3 (rev 1)`, which the server does not have.

- step 1: client2 creates `item-3`. The server never sends it back to client2 before later writes remove it (client1 at step 4, client2 at step 11).
- When client2 rebases over its acknowledged remove, undoing it restores the value it captured locally, `rev 1`.

```
server.pull:
  removes = syncedKeys - records   # syncedKeys holds only keys the server sent,
                                   # never keys the client pushed, so no remove follows
```

This still fails with A fixed, and it causes most no-fault failures: 9 of 150 seeds at 300 steps.

## C. A lost push response rolls back an accepted write: `seed-44-lost-response-rollback.json`

`{ seed: 44, steps: 20, faultRate: 0.1 }`. At the end client2 shows its own `item-1 (rev 1)` while the server and client1 have `rev 6`.

- steps 0 and 1: client2 writes `item-1`; the push is applied, but client2 has not pulled yet.
- step 11: client2's push of `item-3` is applied, so the server's ack for client2 now names that mutation.
- step 19: the push's response is dropped (`responseLost`).

```
push fails → rollback([item-3 write])     # treats a lost response as a rejection, and removes
                                          # the accepted mutation from speculativeMutations
next pull: { set: [item-1 rev 6, item-3 rev 7], ack: <item-3 mutation> }
  findIndex(ack) = -1                     # the acknowledged id is gone, so every older write
                                          # counts as unacknowledged
  replay [item-1 rev 0, item-1 rev 1]     # over the server's rev 6, and they stay speculative
```
