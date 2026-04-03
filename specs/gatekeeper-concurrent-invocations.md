## Problem overview

`@tandem/gatekeeper` currently routes intercepted downstream calls through one mutable `activeInvocation` slot in `packages/gatekeeper/src/Gatekeeper.ts`. That works for a single in-flight top-level async call, but it breaks the moment tests need real distributed-system interleavings.

If `harness.client.doA()` blocks and `harness.client.doB()` starts before `doA()` resumes, the later call overwrites `activeInvocation`. The same shared slot is also touched by unrelated top-level harness calls, including sync ones, so invocation identity can be clobbered even when the second call is not part of the original async chain. After that, resumed execution can attribute downstream work to the wrong invocation or lose gating entirely.

This prevents the class of tests Gatekeeper exists to support: multiple top-level invocations alive at once, blocked on different downstream requests, then resumed in the order the test chooses. That is a core distributed-systems testing need for Tandem flows like concurrent commits, pulls, pushes, retries, and rebases.

## Solution overview

Replace the single global `activeInvocation` model with per-invocation identity. Each top-level invocation gets an `InvocationId`, active invocations live in a `Map<InvocationId, InvocationController>`, and `AsyncLocalStorage<InvocationId>` carries the current invocation through async execution.

Blocked handles store their `invocationId` and use it to look up the live controller when `allowRequest()`, `mockReturnValue()`, or `fail()` is called. Every resume path re-enters the blocked invocation's `AsyncLocalStorage` context before continuing execution. This keeps the existing public handle API, preserves sync/property passthrough and nested proxy behavior, keeps `withUnlockedGates(...)`, and adds correct concurrent top-level invocation semantics.

## Goals

- Support multiple blocked top-level invocations simultaneously.
- Let tests resolve blocked handles out of order with `allowRequest()`, `mockReturnValue()`, and `fail()`.
- Preserve transitive downstream attribution after resume, even when an older blocked invocation resumes after a newer one has already started.
- Keep `withUnlockedGates(...)` available for setup and inspection.
- Preserve sync method and property passthrough behavior.
- Preserve nested proxy behavior and matcher semantics for nested async method paths.
- Keep the current await-based handle model: top-level async harness calls still return `Promise<Handle<T>>`.
- Keep the current per-invocation guardrail that one invocation only exposes one blocked downstream handle at a time.

## Non-goals

- No migrations or backfills.
- Do not preserve the old `activeInvocation` implementation strategy.
- Do not add concurrent blocked fan-out within a single invocation in this spec; that remains an explicit limitation.
- Do not redesign the public `Handle` and matcher API beyond what is required for correct routing and resume behavior.
- Do not add browser or worker compatibility work for async context propagation; this spec assumes a Node runtime with `node:async_hooks` `AsyncLocalStorage` available, which matches the current Vitest/package environment.

## Future work

- None yet.

## Important files/docs/websites for implementation

- `packages/gatekeeper/src/Gatekeeper.ts` — current runtime implementation with the single `activeInvocation` slot, `InvocationController`, `BlockedHandle`, proxy logic, and `withUnlockedGates(...)`.
- `packages/gatekeeper/src/Gatekeeper.test.ts` — the main behavior suite; add the concurrency and resume-context regression coverage here.
- `packages/gatekeeper/src/index.ts` — public export surface; confirm the refactor does not accidentally change the package API.
- `packages/core/src/TandemClient.gatekeeper.test.ts` — downstream integration coverage proving Gatekeeper can model real Tandem interleavings.
- `docs/gatekeeper.md` — public package docs; update the stated limits and examples once concurrent top-level invocation support lands.
- `specs/gatekeeper.md` — earlier Gatekeeper spec for the handle/matcher model; this refactor should stay compatible with that surface while superseding the single-invocation assumption.
- `packages/gatekeeper/package.json` — package scripts for targeted `test`, `type-check`, and `build` verification.
- `https://nodejs.org/api/async_context.html` — Node `AsyncLocalStorage` docs for `run()` and `getStore()` semantics; `run()` is the relevant primitive because it scopes context to the callback and async work created within it.

## Proposed architecture

### Invocation identity and lifecycle

Introduce an opaque `InvocationId` type, implemented as a monotonic integer counter for simplicity and debuggability.

Each top-level harness method call creates an `InvocationController` and a fresh `InvocationId` before invoking user code. The controller is inserted into a live `Map<InvocationId, InvocationController>` immediately so dependency proxies can find it during the first synchronous part of the invocation.

The method body runs inside `AsyncLocalStorage<InvocationId>.run(invocationId, ...)`. If the method throws synchronously or returns a non-promise value, Gatekeeper removes the controller immediately and returns the raw sync result or rethrows the sync error. If the method returns a promise, Gatekeeper keeps the controller alive until the invocation has fully settled and no blocked handle still needs it.

### Dependency proxy routing

Dependency proxies stop reading a global mutable `activeInvocation` variable. Instead they:

1. Check whether gates are temporarily unlocked.
2. Read the current `InvocationId` from `AsyncLocalStorage`.
3. If there is no current invocation in async context, call the real dependency directly.
4. If there is an `InvocationId`, look up the matching controller in the invocation map.
5. If the async context contains an `InvocationId` but the map no longer has a live controller for it, throw a clear invariant error instead of falling back to a direct call.
6. If the controller exists, block that invocation on the downstream request.

This makes downstream attribution a property of the async execution context, not whichever top-level call most recently touched a shared slot.

### Handles store invocation identity

`BlockedHandle` should no longer depend on a permanently captured `InvocationController` reference as its routing mechanism. Instead it stores:

- `invocationId`
- the blocked request matcher data
- the blocked-call resolve/reject callbacks
- the real implementation thunk for `allowRequest()`
- a controller lookup helper that resolves `invocationId` against the live map

Matcher objects remain assertions only. They do not identify the invocation. If two blocked invocations have identical request shapes, the handle's `invocationId` still determines which invocation resumes.

### Resuming inside the original async context

Every successful gate action must re-enter the blocked invocation's async context before it releases the blocked await:

- `allowRequest()` must run the real downstream implementation inside `AsyncLocalStorage.run(invocationId, ...)`.
- `mockReturnValue()` must resolve the blocked call inside that same context.
- `fail()` must reject the blocked call inside that same context.

This is the key requirement for transitive attribution. If invocation `A` is resumed after invocation `B` has already started, any downstream call that happens after `A` resumes must still be attached to `A`.

The same rule handles stale async context safely: `AsyncLocalStorage` store present plus no live controller in the invocation map is an invariant violation, not a reason to bypass gating.

### Cleanup and removal from the invocation map

Cleanup needs slightly more nuance than the current `activeInvocation = null` callback.

- Sync throw or sync non-promise return: remove the invocation from the map immediately.
- Async completion with no active blocked handle: resolve or reject the observer, then remove the invocation from the map.
- Async completion while a blocked handle is still active: keep the controller in the map long enough for the blocked handle to surface the stored terminal error or completion path, then remove it as part of the resume/settle path.

Stale handle actions should fail deterministically with an "already resolved" or equivalent settled-invocation error once the invocation no longer exists in the map.

### `withUnlockedGates(...)`

`withUnlockedGates(...)` stays in the public API and keeps the same caller-facing contract: the callback receives raw services, async methods return raw promises, and sync methods/properties behave normally.

Under the new concurrent model, the bypass must remain scoped to the callback's async work. An unlocked callback should not accidentally disable gating for an unrelated blocked invocation that resumes at the same time. The implementation can satisfy this with a small async-context-scoped bypass flag if the current process-global depth counter is no longer safe enough.

## Expected API and test semantics

The public handle API stays the same. The behavior changes are in routing and ordering semantics.

### Concurrent top-level invocations can block together

```ts
const aPromise = harness.client.doA()
const bPromise = harness.client.doB()

const [a, b] = await Promise.all([aPromise, bPromise])

a.expectRequest({ to: "remote", method: "stepA", args: [1] })
b.expectRequest({ to: "remote", method: "stepB", args: [2] })

const doneB = await b.allowRequest({
	to: "remote",
	method: "stepB",
	args: [2],
})

await expect(a.fail(new Error("boom"))).rejects.toThrow("boom")
expect(doneB.unwrapValue()).toBe("b-result")
```

Both invocations may be blocked simultaneously. The test may resume them in either order. One handle's gate action must not affect the other invocation.

### Resume order must preserve transitive attribution

```ts
const a = await harness.client.doTwoSteps("a")
const b = await harness.client.doTwoSteps("b")

const a2 = await a.allowRequest({
	to: "server",
	method: "stepOne",
	args: ["a"],
})

a2.expectRequest({ to: "server", method: "stepTwo", args: ["a:1"] })
b.expectRequest({ to: "server", method: "stepOne", args: ["b"] })
```

If resuming `a` causes a second downstream request, the next blocked handle returned from `a.allowRequest(...)` must belong to `a`, not `b`, even though `b` is still blocked on a similar request.

### Matchers remain assertions, not routing keys

Two blocked invocations may expose the same request matcher shape. `mockReturnValue()` on one handle and `allowRequest()` on the other must still apply to the correct invocation because routing happens through `invocationId`, not through request comparison.

### Sync passthrough remains unchanged

- Direct sync method calls on harness services still return raw sync values.
- Direct property reads, including nested properties and promise-valued properties like `ready`, remain usable without handles.
- Nested async methods like `harness.client.sync.advanceCursor(1)` still return `Promise<Handle<T>>`, and downstream request matchers continue to use the callee service's method path such as `"advanceCursor"` or `"math.double"`.

### `withUnlockedGates(...)` remains a raw escape hatch

- Calls made through the raw services passed into `withUnlockedGates(...)` bypass interception.
- The bypass only applies to work started inside that callback.
- Leaving the callback restores normal gating.

### Unrelated sync top-level calls must not clobber a blocked invocation

```ts
const blocked = await harness.client.doTwoSteps(1)

expect(harness.client.format(10)).toBe(11)

const next = await blocked.allowRequest({
	to: "server",
	method: "stepOne",
	args: [1],
})

next.expectRequest({ to: "server", method: "stepTwo", args: [2] })
```

Calling a top-level sync harness method while another invocation is blocked must not erase or replace the blocked invocation's identity. After the blocked handle resumes, its continuation must still be gated and attributed to the original invocation.

## Migration risks and open questions

### Fire-and-forget async work

Detached async work created inside an invocation may continue running after the top-level invocation has already settled and been removed from the map. The safest initial behavior is to surface a clear invariant error if such work later hits a gated dependency, rather than silently misrouting it. This case should be documented as unsupported until there is a concrete need to support it.

To make that enforceable, dependency-proxy lookup must distinguish between:

- no async invocation context at all, which is valid passthrough
- an async invocation context with no live controller, which is an invariant error

### Parallel downstream calls inside one invocation

This spec intentionally keeps the current per-invocation limitation: one invocation exposes at most one blocked downstream call at a time. Supporting concurrent blocked fan-out inside one invocation would need a different controller model and is out of scope here.

### `BlockedHandle` and `InvocationController` interaction

The refactor should preserve the current split between per-invocation state (`InvocationController`) and test-facing gate controls (`BlockedHandle`), but it should remove any routing dependence on a globally captured controller. The implementation detail to finalize is whether `prepareForResume(...)` validates by handle instance, blocked-call token, or another small identifier. Any option is acceptable as long as stale handles fail deterministically.

### Cleanup timing and error propagation

The current controller already stores a terminal rejection while a blocked handle is active. The map-based design must not delete the controller so early that the blocked handle loses access to that stored failure. Tests should cover this explicitly.

### `withUnlockedGates(...)` isolation

If the implementation keeps a process-global unlock depth, concurrent invocations may see accidental bypass. The spec goal is callback-scoped bypass semantics, but the exact internal mechanism can be finalized during implementation.

## Implementation

### Phase 1: Move dependency routing to async-context lookup and fix the sync-clobber regression

Replace the shared `activeInvocation` routing path with `InvocationId` plus async-context lookup in one focused slice. Keep this phase centered on the specific bug where an unrelated top-level sync harness call clobbers a blocked invocation.

```ts
type InvocationId = number

const invocationContext = new AsyncLocalStorage<InvocationId>()
const invocations = new Map<
	InvocationId,
	InvocationController<any, TServices>
>()

function getCurrentInvocationOrThrow() {
	const invocationId = invocationContext.getStore()
	if (invocationId === undefined) return null

	const invocation = invocations.get(invocationId)
	if (!invocation)
		throw new Error(`Missing live invocation for context ${invocationId}`)

	return invocation
}
```

- [x] Add an internal `InvocationId` type, live invocation map, and invariant-aware lookup helper that throws when `AsyncLocalStorage` contains an id that is missing from the live invocation map.
- [x] Run top-level harness method execution inside `AsyncLocalStorage<InvocationId>.run(...)` instead of assigning to `activeInvocation`.
- [x] Make dependency proxies resolve the current invocation through the invariant-aware async-context lookup helper.
- [x] Remove the old `activeInvocation` state from the builder once the new routing path is in place.
- [x] Add a focused regression in `packages/gatekeeper/src/Gatekeeper.test.ts` where an invocation blocks, an unrelated top-level sync harness method runs, and the resumed invocation still blocks on its next downstream request.
- [x] Verify `pnpm --filter @tandem/gatekeeper test` passes.

### Phase 2: Move blocked handles to `invocationId` lookup and prove concurrent out-of-order control

Make handle routing depend on live invocation identity rather than a permanently captured controller reference. After this phase, multiple top-level invocations can remain blocked at once and be resolved in either order.

```ts
class BlockedHandle<T> {
	constructor(
		private readonly invocationId: InvocationId,
		private readonly getInvocation: (
			id: InvocationId,
		) => InvocationController<T>,
	) {}

	private lookupInvocation() {
		return this.getInvocation(this.invocationId)
	}
}
```

- [x] Refactor `BlockedHandle` so it stores `invocationId` and resolves the live controller through the invocation map when a gate action runs.
- [x] Ensure stale handle actions fail deterministically once the invocation has been removed from the map.
- [x] Add a focused regression in `packages/gatekeeper/src/Gatekeeper.test.ts` where two top-level invocations block simultaneously and the test allows them in reverse order.
- [x] Add a regression test where two blocked invocations expose identical matcher shapes and still resolve independently because handle identity, not matcher shape, chooses the invocation.
- [x] Verify `pnpm --filter @tandem/gatekeeper test` passes.

### Phase 3: Resume blocked invocations inside their original async context

Re-entry is the behavior change that makes the refactor correct instead of merely concurrent. After this phase, resuming an older blocked invocation preserves its downstream attribution even if newer invocations are already in flight.

```ts
async function resumeInInvocation<T>(
	invocationId: InvocationId,
	action: () => Promise<T>,
) {
	return await invocationContext.run(invocationId, action)
}
```

- [x] Wrap `allowRequest()`, `mockReturnValue()`, and `fail()` in `AsyncLocalStorage.run(invocationId, ...)` before they release the blocked await.
- [x] Keep the existing one-shot blocked-handle guard so each blocked request can only be resolved once.
- [x] Add a Gatekeeper workflow regression test where invocation `A` blocks, invocation `B` blocks, `A` resumes first, and `A`'s continuation produces the next blocked handle for `A` rather than for `B`.
- [x] Verify `pnpm --filter @tandem/gatekeeper test` passes.

### Phase 4: Make cleanup deterministic and preserve error propagation

The controller map now owns invocation lifetime, so cleanup rules need to be explicit. After this phase, stale handles and invocations that settle while blocked fail predictably instead of depending on incidental controller reachability.

```ts
class InvocationController<T> {
	markSettled() {
		this.settled = true
		if (!this.activeBlockedHandle) this.onFullySettled()
	}

	prepareForResume(handle: BlockedHandle<T>) {
		if (this.activeBlockedHandle !== handle)
			throw new Error("Blocked call is already resolved")
		this.activeBlockedHandle = null
		if (this.settled) this.onFullySettled()
	}
}
```

- [x] Define explicit controller cleanup rules for sync return, sync throw, async resolve, async reject, and settle-while-blocked cases.
- [x] Ensure stale handle actions fail with a deterministic settled-invocation error once the invocation has been removed from the map.
- [x] Preserve the existing behavior where a blocked invocation that ultimately rejects still surfaces that rejection through the blocked handle path.
- [x] Add a Gatekeeper test that forces an invocation to settle with an error while a blocked handle is still active, then asserts the next gate action surfaces that error and cleans up the invocation.
- [x] Add a focused test or purpose-built fixture showing that stale async context throws the invariant error instead of falling back to a direct dependency call.
- [x] Verify `pnpm --filter @tandem/gatekeeper test` passes.
- [x] Verify `pnpm --filter @tandem/gatekeeper type-check` passes.

### Phase 5: Keep `withUnlockedGates(...)`, sync passthrough, and nested proxies correct under concurrency

Once invocation routing is fixed, preserve the convenience APIs that existing tests rely on. After this phase, raw setup/inspection still works, but unlocking one async context does not accidentally ungate another active invocation.

```ts
function withUnlockedGates<R>(fn: (services: TServices) => R | Promise<R>) {
	return unlockedGateContext.run(
		true,
		async () => await fn(rawServices as TServices),
	)
}
```

- [ ] Keep `withUnlockedGates(...)` callback semantics unchanged from the caller's perspective.
- [ ] Scope gate bypass to the callback's async work so concurrent invocations do not see accidental global bypass.
- [ ] Add a Gatekeeper test that holds a `withUnlockedGates(...)` callback open while an unrelated blocked invocation resumes, and assert the resumed invocation still blocks on its next downstream request.
- [ ] Re-run and adjust existing nested sync property/method passthrough tests only where the internal routing change requires it; do not change the public contract.
- [ ] Verify `pnpm --filter @tandem/gatekeeper test` passes.

### Phase 6: Document the new concurrency model and validate it in downstream Tandem flows

Finish by aligning docs and integration coverage with the new capability. After this phase, the package docs and Tandem consumer tests describe concurrent top-level invocation support accurately.

- [ ] Update `docs/gatekeeper.md` to say Gatekeeper supports multiple concurrent blocked top-level invocations while still rejecting concurrent blocked fan-out within one invocation.
- [ ] Update `docs/gatekeeper.md` examples or limits language anywhere it still implies a single globally active invocation.
- [ ] Add or update one focused regression in `packages/core/src/TandemClient.gatekeeper.test.ts` that uses two concurrent client operations to prove the new distributed-style interleaving works in a real Tandem scenario.
- [ ] Verify `pnpm --filter @tandem/gatekeeper build` passes.
- [ ] Verify `pnpm --filter @tandem/gatekeeper test` passes.
- [ ] Verify `pnpm --filter @tandem/core test -- TandemClient.gatekeeper.test.ts` passes.
