# Known failures

These recordings reproduce client/server mismatches after healthy settlement. Each JSONL artifact contains run options, scheduled events, and an outcome with final states and the violation. Random runs execute every requested step before checking convergence at `quiescence`.

Settlement disables faults, drains calls, restarts crashed clients from storage, reconnects every client to resend retained writes, drains again, and pulls every client. All clients subscribe to the entire `todos` collection, so each final view must equal the server's state.

`dst.spec.ts` replays each artifact without random choices and requires its recorded violation. When a fix makes the recording converge, move it to the successful regressions and change the assertion. Boundary divergence instead means the recording needs investigation before it can test the bug again.

The server is authoritative. DST does not require every historical mutation to reach it, including writes lost from memory on a crash. It still rejects ghost local records absent from the server after final pulls. Protocol tests separately cover mutation ordering and deduplication.

## Fixed: a lost push request

`dst/regressions/lost-push.jsonl` preserves the original six-event reproduction: client1 writes `item-3`, then its push request is dropped. The sync engine now retains that mutation. Settlement reconnects the client, delivers the write, and pulls both clients into agreement with the server. No automatic retry or persistence is required for this case.

## Remaining: a ghost record survives restart

`seed-13-crash-loses-outbox.jsonl`, recorded with `{ seed: 13, steps: 15, crashRate: 0.1 }`, still violates convergence: client2 shows `item-2 (rev 5)`, which the server never received.

- step 5: client2 writes `item-2`, and the write reaches its storage; the push does not reach the server.
- step 12: client2 crashes.
- At quiescence, the run restarts client2 from storage with a new client id.

```text
client storage persists:  materialized tuples only
not persisted:            pending mutations, speculative mutations, client id, cookie
restart:                  item-2 loads as if it were confirmed data, and no mutation
                          exists to push it, so it never reaches the server
```

The failure is not that the write was lost. The failure is that final pulls leave the client's view different from the server. Dropping the ghost record would satisfy this contract without introducing a durable outbox.
