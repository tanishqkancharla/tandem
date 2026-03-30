## Problem overview

`@tandem/gatekeeper` now exists, but its current blocked-handle API still exposes intercepted request details directly as `service`, `method`, and `args`. That leaks runtime internals into tests and makes request assertions feel like manual object inspection instead of explicit gate checks.

We want to shift the public API to matcher-based request assertions. Tests should declare the request they expect at the gate, and Gatekeeper should throw when the blocked request does not match that expectation before any downstream call is allowed through.

## Solution overview

Keep the await-based handle model: awaiting a harness method still yields either a resolved handle or a blocked handle. Replace the public blocked-request metadata with a required matcher object used by `allowRequest()` and a new `expectRequest()` method.

The matcher shape is:

```ts
type RequestMatcher = {
	to: string | "*"
	method: string | "*"
	args: unknown[] | "*"
}
```

Blocked handles keep the intercepted request internally. `allowRequest(matcher)` only resumes the invocation when the matcher matches; otherwise it throws and leaves the invocation blocked. `expectRequest(matcher)` performs the same match check without resuming the invocation. `mockReturnValue()` and `fail()` remain the escape hatches for bypassing or rejecting the blocked call.

## Goals

- Keep the existing ordered service-harness model for async-method-only services.
- Keep the await-based gate semantics where awaiting a harness method yields the first observable `Handle` for that invocation.
- Stop exposing blocked request metadata directly on the public `Handle` shape.
- Require matcher-based assertions for allowing blocked requests through.
- Support `"*"` wildcards for `to`, `method`, and `args` in matcher-based request assertions.
- Add `expectRequest()` so tests can assert the blocked request shape without resuming the invocation.
- Preserve serial downstream-call support by returning the next `Handle` from gate controls.

## Non-goals

- No migrations or backfills.
- No cyclic or bidirectional service graphs in v1.
- No sync methods, property interception, events, streams, or non-function API members.
- No partial matcher DSL beyond exact equality or the top-level `"*"` wildcard for each matcher field.
- No concurrent fan-out of multiple blocked downstream calls within one top-level invocation.
- No debugger UI, request history browser, or post-run inspection tools in this spec.

## Future work

- Support per-argument wildcards or predicate matchers instead of only exact `args` matching or `"*"`.
- Improve mismatch errors with structured diffs between expected and actual requests.
- Add helper factories like `request.to("server").method("addOne")` if the plain object API becomes noisy.
- Add post-run call history helpers for assertions that do not need to happen at the gate.

## Important files/docs/websites for implementation

- `docs/gatekeeper.md` — the original concept doc and example API; update it to show matcher-based gates instead of direct blocked-request property access.
- `packages/gatekeeper/src/Gatekeeper.ts` — current runtime implementation; remove public request metadata, add matcher validation, and introduce `expectRequest()`.
- `packages/gatekeeper/src/Gatekeeper.test.ts` — rewrite and extend tests to cover matcher-based `allowRequest()` and `expectRequest()` semantics.
- `packages/gatekeeper/src/index.ts` — export the public `Handle` and matcher types that remain in the v1 surface.
- `packages/gatekeeper/package.json` — package scripts used for `test`, `type-check`, and `build` verification.
- `tsconfig.json` — root project references; useful only if exported type changes surface any project-reference issues.
- `vitest.config.js` — shared Vitest config used by the package tests.

## Implementation

### Phase 1: Scaffold the package and prove the basic build loop

This phase already landed. It created the package and made sure the workspace can build and type-check it independently before runtime behavior work.

- [x] Create `packages/gatekeeper/package.json` as a private workspace package with `build`, `type-check`, and `lint` scripts that match the existing package conventions.
- [x] Create `packages/gatekeeper/tsconfig.json` and `packages/gatekeeper/src/index.ts`.
- [x] Add a minimal `packages/gatekeeper/src/Gatekeeper.ts` placeholder export so the package builds before behavior work starts.
- [x] Update root project references only if needed for package-scoped TypeScript builds; do not fix unrelated workspace reference issues in this phase.
- [x] Verify `pnpm --filter @tandem/gatekeeper type-check` passes.
- [x] Verify `pnpm --filter @tandem/gatekeeper build` passes.

### Phase 2: Prove the await-based resolved-handle baseline

This phase also already landed. It established that awaiting a harness method yields a `Handle`, and that the no-downstream-call case resolves cleanly before interception logic is layered on top.

```ts
const harness = new Gatekeeper()
	.add("counter", () => new Counter())
	.build()

const handle = await harness.counter.increment(1)
handle.unwrapValue() // 2
```

- [x] Add a package-level `test` script and the dev dependencies needed to run Vitest in `packages/gatekeeper`.
- [x] Write unit tests first for the base contract: awaiting a built service method yields a resolved `Handle` when no downstream service call occurs, and `unwrapValue()` returns the final top-level value.
- [x] Implement the minimal builder and resolved-handle behavior needed to make those tests pass for services that do not call another registered service.
- [x] Verify `pnpm --filter @tandem/gatekeeper test` passes.
- [x] Add a success check that `await harness.service.method()` can be asserted directly in Vitest, so the handle-returning method contract is proven before interception logic is added.

### Phase 3: Replace direct blocked-request metadata with matcher-based gates

Reshape the public blocked-handle API so tests no longer read `service`, `method`, or `args` directly. Instead, blocked handles keep the intercepted request internal and expose matcher-based assertions through `expectRequest()` and `allowRequest(matcher)`.

```ts
type RequestMatcher = {
	to: string | "*"
	method: string | "*"
	args: unknown[] | "*"
}

const handle = await harness.client.addOneThroughServer(1)

handle.expectRequest({ to: "server", method: "addOne", args: [1] })
const result = await handle.allowRequest({ to: "server", method: "addOne", args: [1] })
```

- [x] Remove `service`, `method`, and `args` from the public `Handle` interface in `packages/gatekeeper/src/Gatekeeper.ts`.
- [x] Introduce a public `RequestMatcher` type with required `to`, `method`, and `args` fields, where each field accepts either an exact value or `"*"`.
- [x] Add `expectRequest(matcher)` to blocked handles; it should throw on mismatch and leave the invocation blocked when the matcher does not match.
- [x] Rename `allow()` to `allowRequest()` and require a `RequestMatcher`; it should throw on mismatch and only resume the invocation when the matcher matches.
- [x] Keep `mockReturnValue()` and `fail()` available for bypassing or rejecting the blocked call without forwarding to the real implementation.
- [x] Add a unit test that `expectRequest({ to: "server", method: "addOne", args: [1] })` succeeds for the blocked request and does not unblock the invocation.
- [x] Add a unit test that `allowRequest({ to: "server", method: "addOne", args: [1] })` forwards the real request and returns the next `Handle`.
- [x] Add a unit test that a mismatched `allowRequest(...)` throws and the blocked invocation can still be resolved afterward with a matching gate action.
- [x] Add a unit test that each matcher field accepts `"*"` and matches successfully when used as a wildcard.
- [x] Verify `pnpm --filter @tandem/gatekeeper test` passes.
- [x] Verify `pnpm --filter @tandem/gatekeeper type-check` passes.

### Phase 4: Preserve serial-call sequencing and guardrails under the matcher API

Carry the matcher-based API through multi-step invocations. Each successful gate control should return the next `Handle`, and the existing v1 guardrail against concurrent blocked fan-out should remain explicit and test-covered.
Keep the suite minimal and story-like: one concrete flow per supported behavior is enough, and branch-by-branch coverage is not the goal.

```ts
const first = await harness.client.doTwoCalls()
first.expectRequest({ to: "server", method: "stepOne", args: [1] })

const second = await first.allowRequest({ to: "server", method: "stepOne", args: [1] })
second.expectRequest({ to: "server", method: "stepTwo", args: [2] })

const done = await second.mockReturnValue(3)
done.unwrapValue()
```

- [x] Add a unit test for two downstream calls in sequence where the first successful gate action returns the second blocked `Handle`.
- [x] Add a unit test that the final successful gate action returns a resolved `Handle` after the invocation finishes.
- [x] Add a unit test that `expectRequest()` does not count as resolving the gate, so a later `allowRequest()`, `mockReturnValue()`, or `fail()` still works exactly once.
- [x] Add a unit test that concurrent fan-out of multiple blocked downstream calls still fails fast with a clear v1 scope error.
- [x] Keep the single-resolution guard so only one successful gate control (`allowRequest`, `mockReturnValue`, or `fail`) can resolve a blocked call.
- [x] Verify `pnpm --filter @tandem/gatekeeper test` passes for both serial sequencing and the concurrent-call guardrail.

### Phase 5: Tighten the exported API surface and docs around the matcher model

Once the runtime behavior is correct, make the public surface explicit and document the new matcher-first API. This phase should leave package consumers with a clean exported type story and examples that no longer mention direct blocked-request property access.

```ts
export type RequestMatcher = {
	to: string | "*"
	method: string | "*"
	args: unknown[] | "*"
}

export type { Handle } from "./Gatekeeper.js"
export { Gatekeeper } from "./Gatekeeper.js"
```

- [x] Export `RequestMatcher` from `packages/gatekeeper/src/index.ts` alongside `Handle` and `Gatekeeper`.
- [ ] Keep the TypeScript surface intentionally simple: explicit annotations in service factories are acceptable in v1, but built harness methods should still expose correctly typed handle-returning promises.
- [ ] Add at least one compile-time usage example in package tests or source that proves later service factories can consume earlier services without resorting to `any` while using the matcher-based API.
- [x] Update any remaining package examples, docs, and test-facing API references from `allow()` to `allowRequest()` and from direct blocked-request property access to matcher-based assertions.
- [x] Update `docs/gatekeeper.md` to show `expectRequest()` and `allowRequest({ to, method, args })` instead of direct `service` / `method` / `args` property access.
- [x] Verify `pnpm --filter @tandem/gatekeeper build` passes.
- [x] Verify `pnpm --filter @tandem/gatekeeper type-check` passes.
- [x] Verify `pnpm --filter @tandem/gatekeeper test` passes.
