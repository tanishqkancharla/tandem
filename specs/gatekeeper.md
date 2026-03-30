## Problem overview

`docs/gatekeeper.md` describes a testing framework concept for pausing service-to-service async calls, but the repo does not yet have an implementation. The current testing utilities only provide fakes like `TestRemote`; they do not let tests run a real service until it blocks on a downstream dependency, inspect that blocked call, and then decide whether to allow, mock, or fail it.

The concept note also leaves the top-level API shape ambiguous. This spec needs to lock down a concrete v1 package API that is small enough to build and test quickly.

## Solution overview

Create a new private workspace package at `packages/gatekeeper` that builds an ordered, acyclic harness of async-method-only services. Each built service method returns a thenable invocation handle instead of a raw promise: tests can call `next()` on that handle to get the next blocked downstream call, resolve that blocked call with `allow()`, `mockReturnValue()`, or `fail()`, and still assert the final top-level result by awaiting the invocation handle itself.

Implementation should follow a test-first rhythm after the package scaffold exists: create the package first, then add the unit tests for each behavior slice before writing the implementation that makes that slice pass. Each committed phase still needs to end in a green package state.

## Goals

- Add a new private `@tandem/gatekeeper` workspace package under `packages/`.
- Build a harness from ordered service factories where later services can depend on proxy-wrapped earlier services.
- Support services whose public API is an object of async methods.
- Return a thenable invocation handle from built service methods so tests can both inspect blocked downstream calls and await the final top-level result.
- Let tests resolve blocked downstream calls with `allow()`, `mockReturnValue()`, or `fail()`.
- Support serial downstream calls within one top-level invocation via repeated `next()` calls.

## Non-goals

- No migrations or backfills.
- No cyclic or bidirectional service graphs in v1.
- No sync methods, property interception, events, streams, or non-function API members.
- No concurrent fan-out of multiple blocked downstream calls within one top-level invocation.
- No publish-ready API stabilization, docs polish, or workspace-wide cleanup unrelated to `@tandem/gatekeeper`.
- No advanced matcher DSL, call history browser, debugger UI, or randomized testing in v1.

## Future work

- Allow concurrent downstream calls within a single invocation.
- Add richer call matching APIs such as filtering by service and method name.
- Add call history and debugging helpers for post-run inspection.
- Make the `unwrapValue()` error message specify which downstream call the invocation is blocked on (service name, method, args).
- Update `docs/gatekeeper.md` and `README.md` with polished examples once the API settles.

## Important files/docs/websites for implementation

- `docs/gatekeeper.md` — source concept and example API for Gatekeeper.
- `package.json` — root Turbo scripts that the new package should plug into.
- `pnpm-workspace.yaml` — confirms new packages under `packages/*` are picked up automatically.
- `turbo.json` — shared build, type-check, lint, and test task pipeline.
- `tsconfig.json` — root project references; update only if the new package needs to participate here.
- `vitest.config.js` — shared Vitest configuration used across the monorepo.
- `packages/testing/package.json` — current private testing package structure to mirror for scripts and metadata.
- `packages/testing/src/TestRemote.ts` — existing test utility style and helper surface for Tandem.
- `packages/core/src/utils/typeUtils.ts` — existing async API utility types that can inform Gatekeeper’s local type design.
- `packages/core/src/query/Query.test.ts` — current Vitest test style in the repo.
- `packages/gatekeeper/package.json` — new package manifest and scripts.
- `packages/gatekeeper/tsconfig.json` — new package TypeScript build config.
- `packages/gatekeeper/src/index.ts` — public exports for the package.
- `packages/gatekeeper/src/Gatekeeper.ts` — builder, proxies, invocation handles, and intercepted call runtime.
- `packages/gatekeeper/src/Gatekeeper.test.ts` — unit tests for the v1 API.

## Implementation

### Phase 1: Scaffold the new package

- [x] Create `packages/gatekeeper/package.json` as a private workspace package with `build`, `type-check`, and `lint` scripts that match the existing package conventions.
- [x] Create `packages/gatekeeper/tsconfig.json` and `packages/gatekeeper/src/index.ts`.
- [x] Add a minimal `packages/gatekeeper/src/Gatekeeper.ts` placeholder export so the package builds before behavior work starts.
- [x] Update root project references only if needed for package-scoped TypeScript builds; do not fix unrelated workspace reference issues in this phase.
- [x] Verify `pnpm --filter @tandem/gatekeeper type-check` passes.
- [x] Verify `pnpm --filter @tandem/gatekeeper build` passes.

### Phase 2: Add the first unit tests and the no-interception invocation handle

- [x] Add a package-level `test` script and the dev dependencies needed to run Vitest in `packages/gatekeeper`.
- [x] Write unit tests first for the base contract: a built service method returns a thenable invocation handle, `await call` resolves the final top-level return value when no downstream service call occurs, and `await call.next()` resolves `undefined` once the invocation settles without any intercepted calls.
- [x] Implement the minimal builder and invocation-handle behavior needed to make those tests pass for services that do not call another registered service.
- [x] Verify `pnpm --filter @tandem/gatekeeper test` passes.
- [x] Add a success check that `await expect(call).resolves` works in Vitest, so the thenable handle contract is proven before interception logic is added.

### Phase 3: Add single-call interception and gate controls

- [x] Write unit tests first for a later service calling an earlier service through a Gatekeeper proxy.
- [x] Add a unit test that `await call.next()` yields intercepted call metadata with service name, method name, and arguments.
- [x] Add a unit test that the top-level invocation remains pending until the intercepted call is resolved.
- [x] Add a unit test that `allow()` forwards the call to the real implementation and unblocks the top-level invocation.
- [x] Add a unit test that `mockReturnValue()` bypasses the real implementation and returns the mocked value instead.
- [x] Add a unit test that `fail()` rejects the top-level invocation with the supplied error.
- [x] Implement dependency proxies, intercepted call records, and single-resolution guards so `allow()`, `mockReturnValue()`, and `fail()` can only resolve a blocked call once.
- [x] Verify `pnpm --filter @tandem/gatekeeper test` passes with all three gate behaviors.

### Phase 4: Support serial downstream calls and enforce v1 guardrails

- [ ] Write unit tests first for a top-level invocation that produces two downstream calls in sequence and requires `next()` to return them in order.
- [ ] Add a unit test that `next()` returns `undefined` after the top-level invocation settles and the blocked-call queue is drained.
- [ ] Add a unit test that concurrent fan-out of multiple blocked downstream calls fails fast with a clear v1 scope error.
- [ ] Implement per-invocation sequencing so serial downstream calls are observable one at a time through repeated `next()` calls.
- [ ] Implement a runtime guard that detects concurrent pending downstream calls within the same invocation and throws a descriptive error.
- [ ] Verify `pnpm --filter @tandem/gatekeeper test` passes for both ordered sequencing and the guardrail case.

### Phase 5: Tighten the exported API surface for package use

- [ ] Export the public runtime types for the v1 surface from `packages/gatekeeper/src/index.ts`, including the builder, invocation handle, and intercepted call handle types.
- [ ] Keep the TypeScript surface intentionally simple: explicit annotations in service factories are acceptable in v1, but the built harness should still expose correctly typed service methods and thenable invocation handles.
- [ ] Add at least one compile-time usage example in the package tests or source that proves later service factories can consume earlier services without resorting to `any`.
- [ ] Verify `pnpm --filter @tandem/gatekeeper type-check` passes with the exported types.
- [ ] Verify `pnpm --filter @tandem/gatekeeper build && pnpm --filter @tandem/gatekeeper test` passes.
