# Known failures

One recorded failure remains here. Fixed recordings and their fixture-specific tests are removed; ordinary public-API tests still cover delivery, durable recovery, and convergence. Each JSONL artifact preserves resolved run options, scheduled events, and the original outcome. Random runs execute every requested step before checking convergence at `quiescence`.

Settlement disables faults, drains calls, restarts crashed clients from storage, reconnects every client to resend retained writes, drains again, and pulls every client. All clients subscribe to the entire `todos` collection, so each final view must equal the server's state.

`dst.spec.ts` replays known failures without random choices and asserts their recorded violation until fixed. Boundary divergence means the recording needs investigation before it can test the bug again; it does not establish that the underlying issue is fixed.

The server is authoritative. DST does not require every historical mutation to reach it, including writes lost from memory on a crash. It still rejects ghost local records absent from the server after final pulls. Protocol tests separately cover mutation ordering and deduplication.

## Unresolved: a removed record remains visible after crashes

`dst/known-failures/crash-removal.jsonl` records seed 18 with ten clients, five IDs per client-owned pool, ten outstanding mutations, a 0.02 crash rate, and no network drops. After 1,000 steps and healthy settlement, client4 still sees `client4-item-1 (rev 176)`, which is absent from the server and the other clients. Replay reproduces the exact violation without boundary divergence. The root cause is not yet isolated.

The recording still reproduces on this checkout. An isolated check against the newer fetched `origin/main` diverges at step 435 because connection changes alter the pending handoffs; a freshly generated seed 18 converges there. Keep the current reproduction until those changes are integrated and the original scenario can be reassessed, rather than treating a different schedule as proof of a fix.

```sh
pnpm dst:run --replay dst/known-failures/crash-removal.jsonl
```

The phase 1 sweep covered seeds 1–20 across 1/2/3/5/10 clients in healthy, dropped-message, crash-only, and combined profiles: 399 runs converged and this one failed. `dst.spec.ts` preserves the recorded failure until a verified fix makes the recording obsolete; a passing replay test is not a claim that this consistency bug is fixed.

```tsx
// Pseudocode: a known-failure test checks reproducibility, not convergence.
const replayed = await replay(artifact)
expect(replayed.divergence).toBeUndefined()
expect(replayed.violation).toEqual(artifact.outcome.violation)
```
