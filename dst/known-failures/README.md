# Known failures

Runs the simulation found that fail because of sync engine bugs we have not fixed yet. Each file is a run's JSONL artifact: a header with the run's options, one line per event it applied, and an outcome line with the final states and the `violation`, meaning the first point where the run disagreed with the reference model, with the expected and actual state. A run stops at the step that violates the model, so a trace ends where its bug happens; `quiescence` means the bug only showed once the run settled.

`dst.spec.ts` replays each artifact with no random choices and requires it to reach its recorded violation. The test fails when the bug is fixed, or when the recording no longer applies to the code; either way, look at it, and delete the recording once the bug is fixed. A random run writes the same format through `jsonlFileSink`, so a new failure can be added here as it is.

The bugs are independent: fixing one still leaves the others failing. Bugs A and B, an empty patch dropping its acknowledgement and a pushed key coming back after its remove was acknowledged, are fixed: the client rebuilds each pull from the server's values instead of undoing writes.

The expected behavior these recordings encode: a client shows the last server state it received plus its own unacknowledged writes, and every write reaches the server unless the server rejects it. That includes writes a client stored before crashing, which Tandem does not implement yet.

## C. A push that fails in transit is treated as a rejection: `seed-2-lost-push-rolls-back.jsonl`

`{ seed: 2, steps: 10, faultRate: 0.1 }`. Violation at step 5: client1 shows nothing, but its write of `item-3` should still be pending.

- step 3: client1 writes `item-3`.
- step 4: its sync tick is delivered, so the push is sent.
- step 5: the push request is dropped (`requestLost`).

```
push fails → rollback([item-3 write])   # a lost message is not a rejection, but Tandem cannot
                                        # tell them apart, so the write is discarded and never
                                        # reaches the server
```

A lost response does the same, although the server did apply the write: the client discards it until a later patch brings the record back, which happens only if the client's window covers it. Nearly every run with faults hits this bug, so fault runs find little else until it is fixed.

## D. A crash loses writes that were stored but not pushed: `seed-13-crash-loses-outbox.jsonl`

`{ seed: 13, steps: 15, crashRate: 0.1 }`. Violation at quiescence: client2 shows `item-2 (rev 5)`, which the server never received.

- step 5: client2 writes `item-2`, and the write reaches its storage; the push does not reach the server.
- step 12: client2 crashes.
- At quiescence, the run restarts client2 from storage with a new client id.

```
client storage persists:  materialized tuples only
not persisted:            pending mutations, speculative mutations, client id, cookie
restart:                  item-2 loads as if it were confirmed data, and no mutation
                          exists to push it, so it never reaches the server
```

The expected behavior is that a stored write still reaches the server after the restart, as it does in Replicache and Triplit, which persist their pending mutations. Tandem does not implement that yet.
