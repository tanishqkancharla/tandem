# Thorough deterministic simulation testing

## Problem overview

The current DST controls concurrent work, drops network handoffs, crashes and restarts clients over durable storage, and records replayable JSONL traces. Those mechanisms already exist in [[dst/DstSimulation.ts]], [[dst/DstWorld.ts]], and [[dst/DstReplay.ts]]. Phase 1 is implemented locally and uncommitted; phases 2–7 remain planned.

Before phase 1, the workload had two hard-coded clients, three record IDs, and a four-pending-call threshold that included timer and pull calls. Topology, ID pools, contention, and outstanding commit count are now configurable. The remaining workload is narrow: one flat `todos` collection and one operation per transaction. Every client subscribes to the entire collection. At the end, `finish()` disables gates, drains work, restarts clients, reconnects, and explicitly pulls before comparing each client's query result to the server.

```diagram
Today
┌───────────────────────────────────────┐
│ N clients; full todos subscriptions   │
└──────────────────┬────────────────────┘
                   │ random writes, drops, crashes
                   ▼
┌───────────────────────────────────────┐
│ Reconnect everyone and force pulls    │
└──────────────────┬────────────────────┘
                   ▼
          All local todos = server todos
```

This catches replica disagreement, but misses much of the application contract: changing subscriptions, filtered and relational results, callback delivery, and recovery without forced repair. More seeds over the same workload do not exercise those behaviors.

Current durable storage includes records, bases, replica identity/counter/cookie, and the outbox. [[packages/core/src/clientStorage/TandemClientStorage.ts#TandemClientStorageApi]] requires atomic durable commits. [[dst/known-failures/README.md]] documents recorded failures; optimistic visibility alone does not prove a write crossed the durability boundary.

## Solution overview

Use server-relative subscription consistency as the main randomized correctness check: after healthy recovery, does each active subscription show the records the application requested? The server remains the authoritative data source. Do not recreate mutation ordering, acknowledgements, conflict resolution, or rebase in a reference replica.

Read server inventories through the public transaction `list()` API, then calculate a small family of expected subscription views with direct test predicates. Compare those views with the actual subscription output, not only a fresh local query. This separates view expectations from Tandem's shared client/server query evaluator without creating another mutation source of truth.

```diagram
┌─────────────────────────┐      ┌─────────────────────────┐
│ Actual server inventory │      │ Client subscribe output │
└────────────┬────────────┘      └────────────┬────────────┘
             │ direct test predicate                     │
             ▼                                           │
┌─────────────────────────┐                              │
│ Expected requested view │──────────────────────────────┘
└─────────────────────────┘       compare after recovery
```

The proposed checkpoint is deliberately smaller than a reference sync engine:

```tsx
// Pseudocode; all proposed types and helpers below are design sketches.
const inventory = await readServerInventory(server.transact())
for (const subscription of activeSubscriptions) {
  const expected = expectedView(inventory, subscription.spec)
  expect(subscription.latestResult).toEqual(expected)
}
```

During outages, stale remote data and outstanding optimistic writes may legitimately differ from the server. Check constrained local-edit promises in isolated scenarios, and check server-relative equality only at healthy settled checkpoints. Keep existing delivery and merge regressions; they protect specific user promises that convergence alone cannot establish.

## Goals

- Configure client count, record count, contention, and mutation concurrency independently.
- Exercise a fixed relational schema, compound IDs, and multi-operation transactions through public APIs.
- Change subscriptions during writes, lost messages, offline periods, and client restarts.
- Check observable subscription results, including callbacks, against authoritative server data.
- Preserve deterministic scheduling and artifact replay for every new operation and checkpoint.
- Distinguish recovery through ordinary client behavior from recovery after explicit repair.
- Report executed behavioral coverage, not just seed counts; make correctness failures visible in CI.

## Non-goals

- A second mutation/reference replica or a general-purpose query interpreter.
- Strong consistency or linearizability while clients are offline or have pending edits.
- Foreign-key enforcement, cascading deletes, or durability guarantees absent from the public API.
- Server crashes, disk corruption, real network transport, or real IndexedDB in this expansion.
- A sync-protocol redesign, schema migration framework, or random schema generator.
- Automatic trace reduction in the initial implementation. Preserve replay first; reduction can follow.
- Compatibility paths for obsolete pre-release artifact formats. Rewrite checked-in reproductions as needed without losing the scenario they protect.

## Implementation phases

### ✅ Phase 1: Configure topology and useful write concurrency

**Today**

Before this phase, `clientNames`, generation counters, harness registrations, final states, and comparisons assumed exactly two clients. `DstRunOptions` only configured seed, steps, and fault/crash rates.

**Proposed**

Add client count, record count, shared-write rate, and maximum outstanding mutations to the run configuration and CLI. Record resolved values so replay constructs the same topology. This is implemented locally; the changes below are uncommitted.

```changes
```

The existing owners remain responsible for construction, scheduling, and replay:

```callstack
 DstSimulation.execute [[dst/DstSimulation.ts#DstSimulation.execute]]
-├── DstWorld.start(seed) [[dst/DstWorld.ts#DstWorld.start]]
+├── DstWorld.start(options) [[dst/DstWorld.ts#DstWorld.start]]
+│   └── buildHarness # register configured timers, stores, then clients [[dst/DstWorld.ts#buildHarness]]
+└── DstSimulation.choose # bound outstanding commits independently of timer/pull calls [[dst/DstSimulation.ts#DstSimulation.choose]]
 replay [[dst/DstReplay.ts#replay]]
+└── DstWorld.start(artifact.options) [[dst/DstWorld.ts#DstWorld.start]]
```

Stable participant names and independent seeded ID streams survive dynamic construction and replay. Gatekeeper registrations use loops while retaining existing crash semantics; dynamic-key assertions stay at the construction boundary. [[dst/DstSimulation.ts#resolveRunOptions]] supplies these defaults:

| CLI flag | Default | Meaning |
| --- | --- | --- |
| `--client-count` | 2 | Clients named `client1` through `clientN` |
| `--record-count` | 3 | IDs per pool, not total records |
| `--max-mutations-in-flight` | 4 | Commit calls whose results have not settled |
| `--shared-write-rate` | 1 | Probability of selecting shared IDs rather than the writer's own pool |

The shared pool uses `item-N`; each owned pool uses `clientK-item-N`. Updates select visible records only within the chosen pool, so an owned update cannot edit another client's IDs. The same resolved configuration is written to the artifact header and shown in sweep summaries.

```tsx
// Pseudocode showing the workload fields added to DstRunOptions.
type DstRunOptions = {
  seed: number
  steps: number
  clientCount?: number
  recordCount?: number
  maxMutationsInFlight?: number
  sharedWriteRate?: number
}
type DstClientName = `client${number}`

const names = Array.from({ length: options.clientCount }, (_, i) => `client${i + 1}`)
for (const name of names) registerClientWithDurableStoreAndTimer(name)
if (outstandingMutations < options.maxMutationsInFlight) {
  const id = rng.boolean(options.sharedWriteRate) ? pickSharedId() : pickOwnedId(client)
  startMutation(client, id)
}
```

Commit tracking lasts through the Gatekeeper handle's final result, not merely until its first held handoff. Recorded drops and crashes terminate their calls normally for scheduling purposes; unexpected commit failures surface instead of disappearing into the concurrency counter.

```tsx
// Pseudocode; beginCommit returns the first held handle before the commit ends.
outstandingMutations += 1
const handle = await beginCommit(client, transaction)
const result = await observeCommitResult(handle)
outstandingMutations -= 1
if (isUnexpectedFailure(result)) return result
```

Construction now depends on recorded configuration, not an implicit pair:

```diagram
Resolved options ──▶ named clients + durable stores ──▶ seeded scheduler
       │                                                        │
       └────────────────▶ artifact header ◀─────────────────────┘
```

- [x] Configure topology, ID pools, contention, and outstanding commit limits.
- [x] Validate positive safe integer counts and probability bounds at the CLI boundary.
- [x] Save resolved options and reconstruct the topology during replay.
- [x] Verify 1/2/3/5/10 clients, same-seed equality, exact replay, and three distinct overlapping writers through commit completion.
- [x] Keep two-client delivery, merge, and replay regressions valid; run type checks, lint, repository tests, and fault/crash sweeps.

Initial phase 1 verification passed `pnpm type-check && pnpm lint && pnpm test`: 208 tests across DST, core, server, React, and Gatekeeper, including 31 DST tests. The CLI also successfully runs and replays a non-default ten-client fault/crash workload. The known failing seed separately regenerates a byte-identical artifact and exits 1 on both execution and replay.

Cleanup removes the fixed lost-push and crash-ghost recordings and their two fixture-specific tests after confirming clean replay on this checkout and fetched `origin/main`. Public-API delivery and recovery coverage remains; the replay-divergence test generates a fresh trace instead of retaining a fixed recording. The remaining 29 DST tests, DST type checks, and lint pass.

Validation used 1,000 steps per seed, seeds 1–20, and 1/2/3/5/10 clients. Each topology ran healthy (`sharedWriteRate: 1`, three IDs), dropped-message (`faultRate: 0.1`, shared rate 0.5, 17 IDs), crash-only (`crashRate: 0.02`, owned IDs only, five IDs), and combined (`faultRate: 0.1`, `crashRate: 0.02`, shared rate 0.4, 17 IDs) profiles. The outstanding limit was `Math.max(2, clientCount)`.

Of 400 runs, 399 converged and one reproduced a consistency violation, with no replay divergence or harness errors. Seed 18 in the ten-client crash-only profile leaves `client4-item-1` visible on client4 but absent from the server after forced repair. [[dst/known-failures/README.md]] documents the saved trace and reproduction command. Its replay test preserves the known failure, not a claim of convergence; the sync root cause remains unresolved and outside this phase.

### Phase 2: Exercise related collections and compound identities

**Today**

`DstSchema`, intents, trace records, queries, and final state only describe flat todos with string IDs. Relations are empty on both server and clients.

**Proposed**

Use one fixed application schema with projects, tasks, comments, and compound-ID project memberships. Configure the same relations on clients and server, and generate operations that create, move, delete, and recreate related records.

Replace todo-specific dispatch at its source rather than introducing a parallel simulation path:

```callstack
 DstWorld.apply [[dst/DstWorld.ts#DstWorld.apply]]
-└── write one todo operation [[dst/DstWorld.ts#DstWorld.write]]
+└── apply a collection-tagged operation through Transaction
 DstSimulation.choose [[dst/DstSimulation.ts#DstSimulation.choose]]
+└── choose meaningful existing records and occasional missing references
```

The proposed data shapes keep relations and identity cases explicit. Declare compound-ID collections with the existing generic `collection<Record>({ fields })` API rather than adding schema primitives solely for DST.

```tsx
type DstSchema = {
  projects: { id: string; name: string }
  tasks: { id: string; projectId: string; text: string; done: boolean; priority: number }
  comments: { id: string; taskId: string; body: string }
  memberships: { id: readonly [string, string]; role: string }
}
type DstOperation = MutationOp<DstSchema> // Existing public operation union.

const task = pickVisibleTask(client)
const operation = rng.pick([
  updateTask(task.id, { projectId: pickDifferentProject(task.projectId) }),
  removeTask(task.id),
  setComment({ id: nextCommentId(), taskId: task.id, body: nextText() }),
])
await world.apply(step, operation)
```

The schema exposes relationship changes without assuming database constraints:

```diagram
Project ──▶ Tasks ──▶ Comments
   │
   └──────▶ Memberships [project ID, member ID]
```

Cover missing parents, reparenting, and tuple IDs that share their first component but differ in the second. Verify collection isolation and exact replay under crashes and message loss; re-record changed regression artifacts while keeping their public outcome assertions. Relation membership follows query semantics, not implicit cascades.

### Phase 3: Schedule multi-operation transactions

**Today**

Each generated write creates and commits a transaction containing one set, update, or remove. Atomic multi-record behavior and operation ordering within a transaction are not exercised by random DST.

**Proposed**

Record an ordered operation list as one mutation event and apply it through one public transaction. Generate cross-collection writes and repeated operations on one identity, without splitting a transaction into independently deliverable mutations.

```callstack
 DstWorld.write [[dst/DstWorld.ts#DstWorld.write]]
 ├── TandemClient.transact [[packages/core/src/TandemClient.ts#TandemClient.transact]]
-├── apply one operation
+├── apply each recorded operation in order
 └── TandemClient.commit [[packages/core/src/TandemClient.ts#TandemClient.commit]]
```

The trace carries application intent, not serialized internal tuples:

```tsx
type DstMutationIntent = {
  type: "mutate"
  client: DstClientName
  ops: DstOperation[]
}

const tx = client.transact()
for (const op of event.ops) {
  if (op.type === "set") tx.set(op.collection, op.value)
  else if (op.type === "update") tx.update(op.collection, op.id, op.payload)
  else tx.remove(op.collection, op.id)
}
startTrackedCommit(client, tx)
```

Only the resulting commit crosses durable/network boundaries:

```diagram
Ordered operations ──▶ one transaction ──▶ one commit ──▶ gated persistence/sync
```

Use focused public-result cases for set→update, set→remove, remove→set, and related-record creation. Check local subscription observations for partial transaction visibility where the API promises atomic local changes, without asserting incidental callback counts or remote atomicity beyond the existing contract. Verify transaction replay and crash/fault sweeps before adding subscription events.

### Phase 4: Change and observe subscriptions

**Today**

`buildHarness()` installs a full todos subscription without retaining its handle or callback results. `finish()` checks fresh `query()` results, not the output the UI subscribes to.

**Proposed**

Record subscribe/unsubscribe events with stable subscription IDs and serializable query descriptions. Keep each app's desired subscription set across crashes and reinstall it when that client restarts; callback state belongs to the current incarnation only.

```callstack
 DstWorld.apply [[dst/DstWorld.ts#DstWorld.apply]]
+├── install or destroy a named subscription
+└── retain immutable snapshots of initial and callback results
 DstWorld.boot [[dst/DstWorld.ts#DstWorld.boot]]
+└── reinstall that app's desired subscriptions
 replay [[dst/DstReplay.ts#replay]]
+└── replay subscription lifecycle events without random choices
```

Use a closed family of subscription descriptions rather than arbitrary executable predicates in JSONL. Generate project-scoped tasks, done/priority filters, ordered pages, projections, and bounded task/comment relations; introduce the simpler cases before relational pagination.

```tsx
type DstSubscriptionSpec =
  | { kind: "projectTasks"; projectId: string; done: boolean; limit: number; offset: number }
  | { kind: "taskComments"; taskId: string }
type DstSubscriptionIntent =
  | { type: "subscribe"; client: DstClientName; id: string; spec: DstSubscriptionSpec }
  | { type: "unsubscribe"; client: DstClientName; id: string }

const handle = client.subscribe(toQuery(event.spec), result => {
  observations.set(event.id, structuredClone(result))
})
observations.set(event.id, structuredClone(handle.result))
activeHandles.set(event.id, handle)
// Unsubscribe destroys only this handle, even if another query overlaps it.
```

Lifecycle state must distinguish app intent from a particular client instance:

```diagram
Subscribe ──▶ active ──▶ unsubscribe ──▶ inactive
                 │
                 └── crash ──▶ restart ──▶ reinstall desired query
```

Cover overlapping/disjoint queries, the final unsubscribe, empty results, resubscription, and a record crossing a filter or page boundary while a response is lost. Preserve active queries during final verification: do not subscribe everyone to everything to make the check easier. Do not require immediate cache eviction after unsubscribe or treat scan windows as access controls.

### Phase 5: Compare user-visible views without a reference replica

**Today**

`finish()` compares all local todos with `server.query()`. Client and server query execution share implementation, and agreement can miss a shared query bug or a subscription that never notifies its consumer.

**Proposed**

Read raw authoritative records with [[packages/server/src/TandemServerTransaction.ts#TandemServerTransaction.list]]. Calculate only the generated subscription families with direct array operations and explicit joins. Compare both the latest observed subscription result and the current local query to the expected view after settlement, distinguishing notification failures from wrong local data.

```callstack
 DstWorld.finish [[dst/DstWorld.ts#DstWorld.finish]]
-├── query all server todos
-└── compare each client's full todo query
+├── read each server collection through transaction.list
+├── calculate the requested views with direct test predicates
+└── compare subscription observations and local query results
```

Failures identify the client, subscription, query, checkpoint, and ordered expected/actual results. Preserve order for ordered queries; normalize unordered inventories only. Do not use Tandem's query encoder, comparator, or evaluator to produce expectations.

```tsx
type DstViewViolation = {
  kind: "subscriptionView" | "subscriptionNotification"
  client: DstClientName
  subscriptionId: string
  spec: DstSubscriptionSpec
  checkpoint: number | "quiescence"
  expected: unknown[]
  actual: unknown[]
}

const expected = inventory.tasks
  .filter(task => task.projectId === spec.projectId && task.done === spec.done)
  .sort((a, b) => b.priority - a.priority || compareIdsDirectly(a.id, b.id))
  .slice(spec.offset, spec.offset + spec.limit)
checkView(latestCallbackSnapshot, expected)
checkView(client.query(toQuery(spec)), expected)
```

Use queries with an explicit ID tie-breaker, asymmetric fixtures, and pages whose offset is nonzero. Literal expected results in focused tests validate the small expectation functions; empty results alone do not establish coverage. Parent deletion and dangling references use the public relation contract, not assumed referential integrity.

```diagram
Server list ──▶ direct view calculation ──▶ expected rows
                                               │
                             ┌─────────────────┴─────────────────┐
                             ▼                                   ▼
                     callback snapshot                     local query
```

Retain targeted write-survival and merge assertions in [[dst/dst.spec.ts]] and [[packages/core/test/persistence.spec.ts]]. Add only constrained probes where needed: a reserved uncontested durable write must reach the server after recovery; a later legitimate overwrite is not data loss. Track completion of the storage adapter's durable boundary rather than inspecting private outbox encodings, and do not predict arbitrary conflict winners.

Before calling pagination correct, execute a sole offset subscription over a larger server inventory: partial-cache evaluation can otherwise apply pagination twice. This is a review hypothesis, not a reproduced defect. A failure should become a minimized regression; never weaken the expected user view to fit the implementation.

### Phase 6: Separate ordinary recovery from forced repair

**Today**

Random faults are individual lost handoffs. Final reconnects and explicit pulls can repair missed propagation, so final agreement does not establish ordinary healthy recovery.

**Proposed**

Add explicit offline/reconnect and sustained per-client partition events, with direction-specific request/reply/poke loss. Keep the scheduler active during a bounded healthy recovery stage, check views, then run the existing forced-repair stage as a separate diagnostic.

```callstack
 DstSimulation.execute [[dst/DstSimulation.ts#DstSimulation.execute]]
 ├── DstWorld.apply [[dst/DstWorld.ts#DstWorld.apply]]
+│   └── change recorded connectivity and partition state
-└── DstWorld.finish [[dst/DstWorld.ts#DstWorld.finish]]
+├── deliver ordinary healthy work within an event budget and check views
+└── reconnect and force pulls, then check repaired views separately
```

Healing a simulated partition restores transport delivery, not a hidden application pull. Restart crashed apps and record their normal boot/reconnect events before checking recovery. Explicit reconnect remains part of recovery for clients whose failed connection requires one; label that scenario separately from continuously connected clients. Local timers and disk handoffs are never network losses.

```tsx
type DstConnectivityIntent =
  | { type: "disconnect" | "reconnect"; client: DstClientName }
  | { type: "partition"; client: DstClientName; direction: "requests" | "replies" | "both" }
  | { type: "heal"; client: DstClientName }
type DstRecoveryResult = {
  ordinary: "passed" | "budgetExceeded" | "viewMismatch"
  repaired: "passed" | "viewMismatch"
  eventsDelivered: number
}

stopGeneratingWritesAndFaults()
restoreTransportDelivery()
const ordinary = await deliverHealthyWorkFairly(recoveryEventBudget)
recordCheckpoint("ordinary", ordinary)
await reconnectAndForcePulls()
recordCheckpoint("repaired", await checkSubscribedViews())
```

Record recovery deliveries/checkpoints for replay; infinite timer streams cannot define quiescence by an empty pending list. A deterministic fair order and an event budget prevent scheduler starvation from masquerading as a product hang. An outer test/process timeout remains a harness safeguard, not the simulation clock.

```diagram
Faulted workload ──▶ heal + ordinary events ──▶ check ordinary recovery
                                                        │
                                                        ▼
                       check repaired views ◀── reconnect + explicit pulls
```

Verify continuously connected propagation without manual pulls, lost-poke recovery via the configured sync timer, long offline write bursts, and reconnect after failed connection. If ordinary recovery fails but repair passes, report that distinction as a failure of the promised recovery scenario rather than silently accepting repaired agreement.

### Server writes and live pokes

Pokes can carry the records a server commit changed in each client's view, and the client shows them before it pulls (see [How sync works](../docs/sync.md#live-records)). Client writes alone rarely exercise that path, and convergence at quiescence cannot see a record that moves backwards mid-run and recovers by the end.

The generator now makes a share of new writes on the server itself, mostly to server-owned records that clients never write, as an agent saving a reply would. Poke events carry their payload, round-tripped through JSON, so a run can deliver, delay, reorder, or drop it like any other poke.

```callstack
 DstSimulation.choose
+├── pick serverSet or serverRemove, mostly on reply-1 and reply-2
 DstWorld.apply
+└── writeOnServer → harness.server.commit(tx)   # its pokes are events the run can lose
 remoteWithPokeEvents
-└── events.on("poke", () => poke())
+└── events.on<PokePayload>("poke", (payload) => poke(payload))
 DstWorld.settle
+└── observeOrder   # each client's server-owned records only move forward in server history
```

Server storage records every value each server-owned record takes, in commit order. After every step, each hydrated client's value must appear in that history at or after the last value it showed. A restart resets the check, because a restarted client shows its last pulled value. The first such violation is reported as `movedBackwards`.

Removing revision retirement, or reapplying live records after a pull's rebuild, or either rule that ignores an older poke, each fails seeds in a 30-seed sweep with faults and crashes. Restart cleanup is covered by `packages/core/test/sync/live.spec.ts` instead, since the check resets on restart.

### Phase 7: Measure exercised coverage and gate sweeps

**Today**

Nightly runs 200 seeds of 500 steps in four fault/crash configurations. It reports outcomes, but omits `--fail-on-violation` and does not summarize whether relevant operations actually occurred.

**Proposed**

Derive a compact coverage summary from executed events and observed outcomes. Use a small PR matrix for regressions and a broader nightly matrix for topology, contention, subscription families, and outages; tune seed counts against measured runtime rather than multiplying every axis blindly.

```callstack
 sweep [[dst/DstCli.ts#sweep]]
+├── aggregate executed coverage and recovery outcomes
 └── sweepSummary [[dst/DstCli.ts#sweepSummary]]
+    └── expose uncovered scenario families and exact reproduction commands
 .github/workflows/dst-nightly.yml [[.github/workflows/dst-nightly.yml]]
+└── fail on violations and retain failing artifacts
```

Count meaningful executed behavior, not merely generated choices. Include mutation participants, conflicting writers, committed batch sizes, compound-ID operations, filter/page transitions, callback observations, fault kinds, and crashes on both sides of the durable boundary.

```tsx
type DstCoverage = {
  mutationsByClient: Record<DstClientName, number>
  multiOperationCommits: number
  subscriptionChanges: number
  nonemptyViewChecks: number
  pageMembershipChanges: number
  dropsByKind: Record<DstFaultKind, number>
  crashesBeforeDurability: number
  crashesAfterDurability: number
}

for (const completedEvent of executedEvents) accumulateCoverage(completedEvent)
const results = await sweep(profile)
requireProfileCoverage(results, profile.requiredCoverage)
failIfAnyViolationOrHarnessFailure(results)
```

Require coverage across a deterministic profile/sweep, not every random seed. Start with 1/2/3/5/10 clients, small hot ID pools and larger inventories, then measure whether the selected budgets actually cover contention and nonempty limited results.

```diagram
Executed traces ──▶ coverage summary ──▶ missing required coverage fails profile
       │
       └──────────▶ violations ──▶ replay ──▶ retain reproduction + fail job
```

Run `pnpm --filter tandem-dst test`, `pnpm --filter tandem-dst type-check`, and `pnpm --filter tandem-dst lint` as phases land, plus relevant deterministic CLI seed sweeps with faults and crashes. Run broader core/server tests when behavior fixes are necessary. Correct the obsolete durability narrative in the known-failures README, keep valid regressions, and retain discovered failures without claiming clean sweeps or changing expectations to suppress them.

## References

- [[dst/DstWorld.ts]] — Harness construction, durable storage, intent application, startup, and final recovery.
- [[dst/DstSimulation.ts]] — Random event selection, current workload limits, and run results.
- [[dst/DstReplay.ts]] — Artifact encoding, replay, and divergence reporting.
- [[dst/DstCli.ts]] and [[dst/cli.ts]] — Sweeps, summaries, CLI options, and exit behavior.
- [[dst/dst.spec.ts]] — Existing convergence, sparse-update, retained-write, crash, and replay regressions.
- [[packages/gatekeeper/src/Gatekeeper.ts]] — Service registrations, held handoffs, events, crashes, and restarts.
- [[packages/core/src/TandemClient.ts#TandemClient.subscribe]] — Public subscription result, callbacks, and lifecycle.
- [[packages/core/src/query/Query.ts]] and [[packages/core/src/query/executeQuery.ts]] — Current query shapes and shared evaluation.
- [[packages/core/src/schema/Schema.ts]] — Collection IDs, runtime fields, and relations.
- [[packages/server/src/TandemServerTransaction.ts]] — Public server inventories without query evaluation.
- [[packages/core/src/clientStorage/TandemClientStorage.ts]] — Durable replica tuples and atomic storage contract.
- [[packages/core/test/persistence.spec.ts]] — Consumer-visible persistence and retry contracts.
- [[.github/workflows/dst-nightly.yml]] — Current seed sweep matrix and failure policy.
