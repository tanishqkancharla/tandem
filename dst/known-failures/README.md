# Known failures

Runs the simulation found that fail because of sync engine bugs we have not fixed yet. Each file is the full `DstSimulation` result for one run: its options, the step-keyed trace, the generated ids, and the final state of the server and every client. A matching test in `../dst.spec.ts` is marked `it.fails`, so it starts failing once the bug is fixed.

A trace replays only with the simulation code that produced it. Until the replay runner exists, re-record a file whenever the simulation loop changes.

## `seed-12345.json`: an acknowledged write survives its deletion

`{ seed: 12345, steps: 50 }`, no faults. At the end the server and client2 are empty, but client1 still holds `item-1` and `item-3`:

- step 40: client1 sets `item-3`; step 46: client2 removes it.
- step 48: client1 sets `item-1`; step 49: client2 removes it.

This loop holds every poke until the run quiesces, so client1 never pulls between its write and client2's delete. Its final pull then returns an empty patch that carries the acknowledgement of its writes:

```
server.pull:  records = {}                          # the window is empty
              removes = syncedKeys - records = {}   # syncedKeys holds only keys the server sent,
                                                    # never keys client1 pushed
              → { set: [], remove: [], ack }
client.applyPatchAt:
              patch is empty → return               # skips the rebase, so the
                                                    # acknowledged writes are never undone
```

The same bug is reproduced through the public API by the `(known bug)` test in `packages/core/test/sync/conflicts.spec.ts`. See "Known sync bugs" in `specs/deterministic-simulation-testing.md`.
