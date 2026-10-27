# Known failures

This directory retains historical Tandem failures. The crash-removal recording has an incompatible schedule on the current stack, as described below. Fixed recordings are removed; ordinary public-API delivery, persistence, and recovery tests remain. A passing known-defect detection test does not mean Tandem satisfies the contract.

Each JSONL artifact preserves resolved configuration, scheduled events, explicit recovery checkpoints, and final inventories. Replay checks event boundaries, checkpoint observations, and the complete final outcome. Boundary divergence requires investigation; it does not establish that a defect is fixed. A seed alone cannot reproduce an older generator's schedule.

## What DST checks

The server is authoritative. At healthy checkpoints, DST reads its records through public transaction `list()` calls and calculates the requested views with direct filtering, ordering, pagination, projection, and joins. It compares both fresh local queries and retained subscription callbacks. It does not predict mutation ordering, conflict winners, or rebase in a reference replica.

Random runs first heal transport, restart crashed clients, reconnect explicitly offline clients, and fairly deliver healthy work within `--recovery-events`. This ordinary stage does not force a pull on connected clients. A separate repair stage reconnects everyone and explicitly pulls. Ordinary mismatches and budget exhaustion remain failures even when repair succeeds. Only active subscriptions are checked; scoped readers receive no hidden full-inventory subscriptions.

The stored recording has an explicit repair checkpoint but no ordinary stage (`ordinary: "notRun"`). They make no ordinary-recovery claim.

```tsx
// Pseudocode: reproducibility is distinct from correctness.
const result = await replay(artifact)
expect(result.divergence).toBeUndefined()
expect(result.violation).toEqual(artifact.outcome.violation)
```

Server-relative consistency cannot detect every lost write if every replica loses it. Focused tests separately verify uncontested durable writes, crash cutpoints, transaction ordering, and local batch observations. A volatile edit may disappear in a crash before durable storage commits; an edit that crossed that boundary must survive. Do not infer durability from optimistic visibility.

## Historical, unresolved: a removed record remains visible after crashes

`crash-removal.jsonl` preserves phase 1's seed 18 schedule: ten clients, five IDs per client-owned pool, ten outstanding mutations, a 0.02 crash rate, and no network drops. All 1,000 workload events retain their original steps and handoff boundaries. The schema translation changes todos to tasks with `projectId: "missing-project"`; each original operation is wrapped as a one-operation batch.

The recorded outcome has client4 seeing task `client4-item-1`, text `Note client4-item-1 (rev 176)`, absent from the server and other clients after forced repair. The root cause was not isolated.

```sh
pnpm dst:run --replay dst/known-failures/crash-removal.jsonl
```

With append batching integrated, replay stops at step 32 because `client1.poke#1` reaches a different recorded boundary. The original 1,000 workload events and expected ghost remain intact for investigation; the test verifies that replay reports the incompatible schedule, not successful recovery. This is no longer an executable reproduction of the ghost on the current stack. Neither a different event schedule nor replay divergence proves the defect is fixed.

## Ordinary recovery limitation: a lost poke can leave no scheduled pull

`recovery.spec.ts` drops a server poke, heals transport, and verifies that ordinary recovery reports a view mismatch while forced repair succeeds. Healing must not silently schedule an application pull. The configured sync timer debounces queued work; it is not periodic polling and does not by itself reacquire a lost notification.

The current fault profile exposes ordinary stale project views at seeds 15 and 19 over 300 steps with five clients. Both pass explicit repair. The CLI continuation test verifies that the first violation does not stop later seeds and retains artifacts for each mismatch. A separate focused test deliberately loses a poke and checks ordinary recovery against forced repair. These scenarios are distinct from the historical crash ghost.

Randomized sweeps do not exempt equivalent known failures. CI passes `--fail-on-violation`, fails on incomplete recovery or missing required coverage, and uploads failing artifacts with replay commands.

## Shared-tab fault sweeps

`--tabs N` adds shared-storage tabs to the current multi-collection workload. Tab server calls use Gatekeeper; channel messages, saves, timers, and pokes are also scheduled steps. Ordinary recovery records tab reopen, reconnect, flush, and retained-write connect operations for exact replay. Sweep summaries include aggregate tab coverage.

The tab simulation checks forwarding and durability separately from convergence. A 150-seed fault/crash sweep with three tabs found 17 ordinary stale-view mismatches, all on standalone clients, and no forced-repair mismatches. The no-tab workload also reproduces stale views after lost notifications. In `tmp/merge-pr73-20261025/seed7.jsonl`, lost `client1.poke` calls precede an old project in client1's ordinary view; replay reproduces the mismatch. These ordinary failures remain reported.
