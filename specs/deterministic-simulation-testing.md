# Thorough deterministic simulation testing

## Problem overview

The DST controls concurrent work, drops network handoffs, crashes and restarts clients over durable storage, and records replayable JSONL traces. Those mechanisms live in [[dst/DstSimulation.ts]], [[dst/DstWorld.ts]], and [[dst/DstReplay.ts]]. All seven phases are implemented; phases 2–7 are oracle-reviewed. Phase 1 is committed locally; phases 2–7 are uncommitted. Nothing has been pushed. Harness checks pass, but the expanded sweeps expose unresolved Tandem failures.

Before phase 1, the workload had two hard-coded clients, three record IDs, and a four-pending-call threshold that included timer and pull calls. Through phase 2, clients subscribed to full inventories and `finish()` reconnected and explicitly pulled before comparing records. The later phases replace that limited checkpoint with active consumer views, ordered batches, subscription lifecycle events, and separate ordinary/forced recovery checks.

```diagram
Phase-2 baseline
┌───────────────────────────────────────┐
│ N clients; four full collections     │
└──────────────────┬────────────────────┘
                   │ random writes, drops, crashes
                   ▼
┌───────────────────────────────────────┐
│ Reconnect everyone and force pulls    │
└──────────────────┬────────────────────┘
                   ▼
          All local inventories = server inventories
```

That baseline catches replica disagreement, but misses changing subscriptions, filtered and relational results, callback delivery, and recovery without forced repair. More seeds over the same workload do not exercise those behaviors.

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

Add client count, record count, shared-write rate, and maximum outstanding mutations to the run configuration and CLI. Record resolved values so replay constructs the same topology.

```changes
2bed937
```

The existing owners remain responsible for construction, scheduling, and replay:

```callstack
 DstSimulation.execute [[2bed937:dst/DstSimulation.ts#L80-L109]]
-├── DstWorld.start(seed)
+├── DstWorld.start(options) [[2bed937:dst/DstWorld.ts#L348-L378]]
+│   └── buildHarness # register configured timers, stores, then clients [[2bed937:dst/DstWorld.ts#L683-L738]]
+└── DstSimulation.choose # bound outstanding commits independently of timer/pull calls [[2bed937:dst/DstSimulation.ts#L111-L143]]
 replay [[2bed937:dst/DstReplay.ts#L89-L102]]
+└── DstWorld.start(artifact.options) [[2bed937:dst/DstWorld.ts#L348-L378]]
```

Stable participant names and independent seeded ID streams survive dynamic construction and replay. Gatekeeper registrations use loops while retaining existing crash semantics; dynamic-key assertions stay at the construction boundary. [[2bed937:dst/DstSimulation.ts#L39-L53]] supplies these defaults:

| CLI flag                    | Default | Meaning                                                               |
| --------------------------- | ------- | --------------------------------------------------------------------- |
| `--client-count`            | 2       | Clients named `client1` through `clientN`                             |
| `--record-count`            | 3       | IDs per pool, not total records                                       |
| `--max-mutations-in-flight` | 4       | Commit calls whose results have not settled                           |
| `--shared-write-rate`       | 1       | Probability of selecting shared IDs rather than the writer's own pool |

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

const names = Array.from(
	{ length: options.clientCount },
	(_, i) => `client${i + 1}`,
)
for (const name of names) registerClientWithDurableStoreAndTimer(name)
if (outstandingMutations < options.maxMutationsInFlight) {
	const id = rng.boolean(options.sharedWriteRate)
		? pickSharedId()
		: pickOwnedId(client)
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

### ✅ Phase 2: Exercise related collections and compound identities

**Today**

Before this phase, `DstSchema`, intents, trace records, queries, and final state only described flat todos with string IDs. Relations were empty on both server and clients.

**Proposed**

Use one fixed application schema with projects, tasks, comments, and compound-ID project memberships. Configure the same relations on clients and server, and generate operations that create, move, delete, and recreate related records.

The implementation is uncommitted:

```changes

```

Replace todo-specific dispatch at its source rather than introducing a parallel simulation path:

```callstack
 DstWorld.apply [[dst/DstWorld.ts#DstWorld.apply]]
-└── DstWorld.write # apply a todo operation
+└── DstWorld.write # apply one collection-tagged MutationOp [[dst/DstWorld.ts#DstWorld.write]]
 DstSimulation.choose [[dst/DstSimulation.ts#DstSimulation.choose]]
+└── DstSimulation.chooseOperation # choose visible targets and occasional missing references [[dst/DstSimulation.ts#DstSimulation.chooseOperation]]
 DstWorld.finish [[dst/DstWorld.ts#DstWorld.finish]]
+├── DstWorld.serverInventory # query all four server collections [[dst/DstWorld.ts#DstWorld.serverInventory]]
+└── DstWorld.inventoryOf # compare every client's four collections [[dst/DstWorld.ts#DstWorld.inventoryOf]]
```

The data shapes keep relations and identity cases explicit. Collections use the existing generic `collection<Record>({ fields })` API; no schema primitives or production sync behavior change.

```tsx
type DstSchema = {
	projects: { id: string; name: string }
	tasks: {
		id: string
		projectId: string
		text: string
		done: boolean
		priority: number
	}
	comments: { id: string; taskId: string; body: string }
	memberships: { id: readonly [string, string]; role: string }
}
type DstInventory = { [C in keyof DstSchema]: DstSchema[C][] }
// Mutation intents reuse the public operation union; controls remain unchanged.
type WriteIntent = MutationOp<DstSchema> & { client: DstClientName }
type WriteTrace = WriteIntent & { step: number; mutationId: number }
type DstViolation = {
	kind: "clientState"
	step: "quiescence"
	client: DstClientName
	collection: keyof DstSchema
	expected: DstSchema[keyof DstSchema][]
	actual: DstSchema[keyof DstSchema][]
}
```

[[dst/DstSimulation.ts#DstSimulation.chooseOperation]] chooses collections uniformly. Updates target visible records in the chosen shared or owned pool; removals prefer visible targets 80% of the time when available. Parent references resolve to a visible record 80% of the time when candidates exist, and otherwise deliberately dangle. Reparenting excludes the current parent.

```tsx
// Pseudocode for the generated workload, not a second mutation model.
const collection = rng.pick(["projects", "tasks", "comments", "memberships"])
const visible = world.inventoryOf(client)[collection]
const target = pickVisibleRecordInChosenPool(visible)
if (remove) return removeRecord(collection, preferExisting(target))
if (update && target)
	return updateRecord(collection, target.id, sparsePayload(target))
return setRecord(collection, recordWithVisibleOrMissingParent())
```

All string-ID collections reuse the same pool names, so identical IDs across collections occur naturally. `recordCount` bounds each collection's shared/owned ID pool; for memberships it bounds the second tuple component, with ownership determined by that member ID. Memberships may therefore outnumber `recordCount` as project/member pairs multiply.

[[dst/DstWorld.ts#dstRelations]] configures both directions of project/task and task/comment relationships on clients and server. Memberships carry their project in the tuple identity; the current relation API joins whole fields, not tuple components, so no membership join is declared. The schema does not assume database constraints:

```diagram
Project ──▶ Tasks ──▶ Comments
Memberships: [project ID, member ID] identifies each independent record
```

Clients subscribe to all four collections at startup and after restart. Settlement reads and sorts every collection by its full JSON-encoded ID; violations identify the first mismatching client/collection and retain complete records. Replay preserves collection tags, tuple IDs, and sparse payloads. The independent inventory evaluator and actual subscription callback comparisons remain in phase 5.

```tsx
// Pseudocode; the server remains the source of truth.
for (const client of clients) {
	for (const collection of collections) {
		compare(client.inventory[collection], server.inventory[collection])
	}
}
```

- [x] Use the fixed schema and configure the same relations on clients and server.
- [x] Generate set, sparse update, remove, reuse/recreation, and task/comment reparenting with meaningful existing targets and missing references.
- [x] Verify nested relations, missing parents, deletion without cascades, collection isolation, and compound identities with shared first or second components through public APIs.
- [x] Preserve deterministic runs and exact fault/crash replay, including all twelve collection/operation combinations and both reparenting operations in the 2,000-step replay test.
- [x] Re-record the known crash-removal scenario without losing its failing outcome, and run repository checks and multi-topology fault/crash sweeps.

`pnpm type-check && pnpm lint && pnpm test` passes with 208 tests, including 31 DST tests; unchanged packages reuse Turbo's cached results. A 400-run sweep uses the same seeds, topologies, profiles, and 1,000-step budgets described in phase 1. All 400 new-schema runs converge, with no thrown runs. The executed traces include set/update/remove in every collection, 6,760 lost pokes, 4,666 lost requests, 3,581 lost responses, and 3,957 crashes. These changed schedules do not establish that the prior bug is fixed.

The old crash-removal recording is translated from todo operations to task operations with a fixed missing parent. All 1,000 original events retain their schedule and handoff boundaries, and the same ghost task remains on client4 after settlement. Its replay test still asserts the original user-visible inconsistency. [[dst/known-failures/README.md]] explains why its schedule is independent of the current random generator.

### ✅ Phase 3: Schedule multi-operation transactions

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
	ops: MutationOp<DstSchema>[]
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

Implemented batches reuse the public operation union directly. Half the batches contain 1–4 independently chosen operations; the remainder create related project/task/comment records or exercise repeated task identities. One batch creates one transaction and one tracked commit. The literal-result case covers ordering and relation results; callback atomicity is checked with phase 4's retained handles.

The 32 DST tests pass. Fifty combined-fault/crash runs (seeds 1–10, 1/2/3/5/10 clients, 1,000 steps) converge and replay their recorded events with matching violations. Oracle found no blockers and requested batch-shape assertions in the seeded replay test; those now protect generated sizes 1–4, cross-collection batches, and same-identity operation order. Full final-state replay comparison is added with recorded recovery checkpoints in phase 6.

### ✅ Phase 4: Change and observe subscriptions

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
	| {
			kind: "projectTasks"
			projectId: string
			done: boolean
			limit: number
			offset: number
	  }
	| { kind: "taskComments"; taskId: string }
type DstSubscriptionIntent =
	| {
			type: "subscribe"
			client: DstClientName
			id: string
			spec: DstSubscriptionSpec
	  }
	| { type: "unsubscribe"; client: DstClientName; id: string }

const handle = client.subscribe(toQuery(event.spec), (result) => {
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

[[dst/DstSubscriptions.ts]] implements task pages with optional project/done filters, minimum priority, explicit priority/ID order, offset, and projection; task/project relations have independent child limits. Full inventories remain an explicit scenario option, not hidden subscriptions. CLI runs start scoped; the world driver defaults to full inventories for focused delivery/durability scenarios.

[[dst/DstWorld.ts#DstClient.observe]] models a subscribe-and-refresh application action. Gatekeeper cannot own remote handoffs started by a synchronous proxied root, so the small async adapter installs the public subscription and awaits public refresh; this does not prove bare subscription-triggered acquisition. Initial and restarted subscriptions install inside the client factory before connecting.

Every handle owns cloned initial and callback histories. Removing a handle removes it from the active map but does not suppress its callback history; this lets tests catch a broken destroy. Only a dead incarnation stops observing. Six public workflows cover overlaps, disjoint queries, last unsubscribe/resubscribe, restart, every local batch snapshot, lost requests across page transitions, and delivering an old response after replacing the same subscription ID.

Oracle's phase-4 review found that active-map callback filtering concealed broken unsubscribe behavior. That filtering is removed, and the requested stale-response replacement case passes. A 40-run combined fault/crash matrix (seeds 1–4, 1/2/3/5/10 clients, full and scoped starts, 1,000 steps) has three view violations and no replay divergence; these are not described as clean convergence.

### ✅ Phase 5: Compare user-visible views without a reference replica

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
	.filter(
		(task) => task.projectId === spec.projectId && task.done === spec.done,
	)
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

[[dst/DstWorld.ts#DstWorld.serverInventory]] now uses one public read transaction's four `list()` calls and cancels it with disposable cleanup. [[dst/DstSubscriptions.ts#expectedView]] contains only the four closed direct view calculations. Checkpoints compare both fresh local results and retained consumer observations with structural equality; arrays keep query order. Nine asymmetric literal tests cover filters, thresholds, ties, offset, projections, nested limits, tuple identities, and dangling references. A separate checker test injects a stale observation while local/server rows agree, protecting notification-only detection.

The sole-offset hypothesis was reproduced at this phase: the reader cached the requested server row but applied the offset again. The later custom-mutations follow-up fixes scan-window collection to include the prefix before the requested page; [[dst/views.spec.ts]] now asserts the literal nonempty result for a sole reader subscription. The prior failing recording was removed. Oracle found no phase-5 design blockers and requested the notification-only checker case and minimal artifact; both were implemented at this phase.

### ✅ Phase 6: Separate ordinary recovery from forced repair

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
	| {
			type: "partition"
			client: DstClientName
			direction: "requests" | "replies" | "both"
	  }
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

[[dst/DstRecovery.ts#recover]] records recovery deliveries and both checkpoints. Its FIFO round-robin queue appends new calls behind waiting work. Settlement requires no active commits, unloaded or offline clients, or held calls; requesting reconnect is not the same as completing it. The event budget bounds recovery, and an outer process timeout remains a harness safeguard rather than the simulation clock.

```diagram
Faulted workload ──▶ heal + ordinary events ──▶ check ordinary recovery
                                                        │
                                                        ▼
                       check repaired views ◀── reconnect + explicit pulls
```

Fifteen public-driver tests cover connected propagation, twelve offline durable commits, directional partitions, restart survival, failed connections, lost pokes, zero/one-event exhaustion, and replay beyond the workload budget. Empty reconnect and pending-pull cases cannot report success at budget zero. Header-only and truncated recordings report actual completed progress; changing only a recorded final inventory causes divergence.

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

Server storage records every value each server-owned task takes, in commit order. After every step, each hydrated client with a full tasks subscription must show a value in that history at or after the last value it showed. A restart or removal of the full subscription resets the check: hydration can restore older saved values, and scoped queries may legitimately evict records. The first such violation is reported as `movedBackwards` and remains a failure even if final views converge. No hidden inventory subscription is added to scoped readers.

Removing revision retirement, or reapplying live records after a pull's rebuild, or either rule that ignores an older poke, each fails seeds in a 30-seed sweep with faults and crashes. Restart cleanup is covered by `packages/core/test/sync/live.spec.ts` instead, since the check resets on restart.

The configured sync timer debounces queued work; it is not periodic polling. A lost poke can leave no scheduled work, so that focused scenario reports an ordinary mismatch despite successful repair. Healing does not manufacture a pull. [[dst/known-failures/README.md]] documents this limitation. Oracle's phase-6 re-review ran all fifteen tests and found no remaining blockers after the settlement, progress-counting, and fairness corrections.

```tsx
// Pseudocode: repair cannot erase an ordinary recovery failure.
const ordinary = await deliverWithinBudgetAndCheckViews()
const repaired = await reconnectPullAndCheckViews()
return {
	violation: ordinary.violation ?? repaired.violation,
	recovery: { ordinary: classify(ordinary), repaired: classify(repaired) },
}
```

### ✅ Phase 7: Measure exercised coverage and gate sweeps

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

[[dst/DstCoverage.ts]] aggregates observations across seeds and checks the selected `writes`, `subscriptions`, `faults`, `crashes`, or `all` requirements. [[dst/DstWorld.ts]] counts effective public operations only after their commit result succeeds; missing/empty updates and empty transactions receive no mutation credit. Cross-client conflicts count overlapping outstanding identity sets, never predicted values.

Page membership uses callback identity sets, excluding initial acquisition and reorder-only changes. Filter coverage uses public writer-local before/after reads for the whole transaction, requiring an existing record to cross an active query's predicate; this is not proof that a remote reader saw the crossing. Callback and final-view checks provide separate evidence. Nonempty offset, compound-ID, and relation checks require real expected rows, and crash counters identify actual storage entry/exit boundaries.

```tsx
// Pseudocode: counters describe execution, not another mutation model.
const commit = startPublicCommit(ops)
if (overlapsAnotherOutstandingWriter(ops)) coverage.conflictingMutations++
await commit
countSuccessfulOperationsAndBatchSize(ops)

onSubscriptionCallback((rows) => recordActualMembershipChange(rows))
onCrash((boundary) => countBeforeOrAfterStorageCommit(boundary))
```

[[dst/coverage.spec.ts]] separately tests counter aggregation/requirements and actual public workflows. Negative cases reject no-op updates, remove→update, initial fetching, reorder-only changes, and a batch that flips a predicate then restores it. Positive cases check real predicate crossings, overlapping committed batches, nonempty views, and absent/surviving records across durable crash cutpoints. These are constrained literal-result tests, not a randomized reference replica.

The CLI exposes `--connectivity-rate` and `--recovery-events` in addition to topology/subscription controls. `--require-coverage` makes missing aggregate coverage fail. Sweeps preserve and replay every failing artifact; budget exhaustion fails even if there is no view mismatch. Single-run and replay commands also fail on exhaustion. [[dst/DstCli.spec.ts]] exercises these paths through the actual CLI, including invocation-relative paths and invalid options.

```tsx
// Pseudocode: a successful repair does not make the sweep pass.
const coverage = aggregateCoverage(completedRuns.map((run) => run.coverage))
const failed = runs.some(
	(run) => run.violation || run.recovery.ordinary === "budgetExceeded",
)
exitWithFailureIf(
	failed ||
		harnessFailed ||
		missingCoverage(coverage, requiredProfile).length > 0,
)
```

[[.github/workflows/dst-nightly.yml]] now runs three fixed-seed PR profiles (twelve seeds, 2,000 steps each) and extends them nightly to 100 seeds at 4,000 steps. Nightly adds two-client hot-pool and ten-client larger-inventory runs; the additional steps still execute after an earlier failure. Every sweep passes `--fail-on-violation`, requires relevant coverage, writes a job summary, and uploads failures. Known defects are not exempted.

### Validation before live-poke integration

The final corrected-counter validation includes an 80-run matrix: seeds 1–4, 1/2/3/5/10 clients, full/scoped starts, and healthy versus combined lost-message/crash/partition profiles at 1,000 steps. It takes 13.1 seconds in this orb, exercises every `all` requirement, and detects five view violations without budget failures or replay divergence. All three twelve-seed PR profiles exercise their requirements; scoped views fail on two reproducible mismatches.

Each nightly profile also runs its first twelve date-based seeds at 4,000 steps after the counter corrections. All required metrics are exercised. The ten-client prefix takes 80 seconds and detects ten failing runs; the wider inventory exposes more failures than the small hot pool. The full 100-seed ten-client workload took 612 seconds before the final counter corrections, establishing runtime feasibility rather than acceptance of the earlier metrics.

Across the final matrix, PR profiles, nightly prefixes, and a re-run of a discovered budget-exhaustion seed, 177 runs produce 155 clean results, 21 view violations, and one exhausted 5,000-event recovery budget. Every failing artifact replays without divergence, and there are no harness errors. The budget-exhaustion case also retains a repaired view mismatch; it is not described as proof of a product hang.

Oracle's phase-7 re-review finds no remaining blockers after rejecting no-op mutation credit and false membership transitions. Before integration, `pnpm type-check && pnpm lint && pnpm test` passes, including 120 DST tests; unchanged package checks reuse Turbo caches. At that point the crash-removal and sole-offset artifacts reproduce their literal mismatches. Passing harness tests do not mean these Tandem defects are fixed. The integration below changes the schedules, so these measurements are historical, not acceptance evidence for the merged generator.

```sh
pnpm dst:run --runs 12 --seed 1 --steps 2000 --client-count 3 --record-count 5 \
  --max-mutations-in-flight 8 --initial-subscriptions scoped --subscription-rate 0.15 \
  --connectivity-rate 0 --require-coverage subscriptions --fail-on-violation
```

### Integration with upstream live pokes

Server-originated writes now create and remove tasks alongside the configurable client transaction batches. Client-generated task IDs exclude the reserved `reply-1` and `reply-2` pool. JSON poke payloads still cross the gated transport; the server-owned task history checker and server-relative subscription checker both contribute violations. Focused workflows verify a newer poke becomes visible before its confirming pull, an older held poke cannot roll it back, and replacing a full subscription with a disjoint scoped view can legitimately evict a task.

The merged scoped profile runs seeds 1–24 at 2,000 steps and finds five view violations, nineteen clean runs, and no replay divergence or harness errors. Seeds 1 and 2 now exercise CLI continuation and exit gating; the fault/crash replay coverage workload grows to 4,000 steps to continue exercising task and comment reparenting alongside server writes.

At this integration point, the sole-offset recording still reproduced the empty-page defect. A later custom-mutations follow-up fixes it and replaces the known-failure assertion with a passing sole-reader regression test. The original crash-removal recording is retained intact, but replay now reports schedule incompatibility at step 51 rather than reaching its old ghost. Its test and [[dst/known-failures/README.md]] explicitly distinguish this from fixing the defect. A separate literal, exactly replayed detection test retains an ordinary comment-removal mismatch exposed by the merged generator, even though forced repair succeeds.

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
