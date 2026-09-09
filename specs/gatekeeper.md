# Gatekeeper

## Problem overview

Tandem tests (and other multi-service tests) need a way to pause, inspect, and decide the outcome of async calls between services. Today there is no shared helper for that, so tests either let calls run through immediately or mock at the wrong layer.

## Solution overview

Add a `packages/gatekeeper` workspace package that wraps named async services in gates. A test builds a harness, calls service methods, and then `allow()`, `mockReturnValue()`, or `fail()` each gated call. Later services receive proxies of earlier ones, so service-to-service calls pause until the test settles them.

Source concept: [Gatekeeper Notion page](https://app.notion.com/p/331ac9fb35f180aeb6cbf02311f76ed1).

## Goals

- A developer registers named async services on `Gatekeeper` and gets a typed harness from `build()`.
- A later service factory receives previously registered services as proxies that implement the same async methods.
- Calling a harness service method returns a `GateCall` with `args`, `allow()`, `mockReturnValue()`, and `fail()`.
- `allow()` runs the real method. `mockReturnValue()` skips it. `fail()` rejects with the given error.
- Calls from one service into another pause until the test settles them through `harness.nextCall()`.
- TypeScript infers harness service names, method arguments, and `GateCall` result types.

## Non-goals

- No migrations or backfills.
- No npm publish, JSR publish, or extraction into a separate repository.
- No TandemClient/Remote wiring. This package is generic; Tandem can consume it later.
- No auto-passthrough of nested calls. Every inter-service hop is explicit in v1.
- No Vitest matchers, fixtures, or time-travel helpers.
- No gating of events, callbacks, streams, or non-function properties.

## Important files/docs/websites for implementation

- [Gatekeeper Notion page](https://app.notion.com/p/331ac9fb35f180aeb6cbf02311f76ed1) - Original API sketch this spec tightens.
- `packages/core/src/utils/typeUtils.ts` - Existing `AsyncApi` / `AnyAsyncFunctionMap` types. Gatekeeper stays independent and defines the small types it needs.
- `packages/core/package.json` - Package layout, scripts, and tooling to copy for the new workspace package.
- `packages/core/tsconfig.json` and `packages/core/tsconfig.test.json` - TypeScript project and test typecheck config to copy.
- `vitest.config.js` - Root Vitest config; add a source alias for the new package.
- `pnpm-workspace.yaml` - Already includes `packages/*`, so a new package folder is enough.
- `packages/gatekeeper/src/Gatekeeper.ts` - Builder, harness proxies, and `GateCall`.
- `packages/gatekeeper/src/index.ts` - Public exports.
- `packages/gatekeeper/test/Gatekeeper.spec.ts` - Consumer-style API tests using the Notion server/client example.
- `packages/gatekeeper/test/Gatekeeper.types.ts` - Type-level inference coverage.

## Implementation

### Phase 1: Add the gatekeeper workspace package

Create a publishable-shaped workspace library that Turbo can build, type-check, and test. Keep it independent of tandem-core.

```ts
export class Gatekeeper<Services extends Record<string, object> = {}> {
	add<Name extends string, Service extends object>(
		name: Name,
		factory: (deps: Services) => Service,
	): Gatekeeper<Services & { [K in Name]: Service }> {
		return new Gatekeeper()
	}

	build(): Harness<Services> {
		return { nextCall: async () => new GateCall() } as Harness<Services>
	}
}
```

- [x] Add `packages/gatekeeper/package.json` as `@tanishqkancharla/tandem-gatekeeper` with the same scripts as `packages/core` (`build`, `type-check`, `format`, `lint`, `test`).
- [x] Add `packages/gatekeeper/tsconfig.json` and `packages/gatekeeper/tsconfig.test.json` extending the repo root tsconfig.
- [x] Export the public API from `packages/gatekeeper/src/index.ts`.
- [x] Alias `@tanishqkancharla/tandem-gatekeeper` to `packages/gatekeeper/src/index.ts` in `vitest.config.js`.
- [x] Verify `pnpm install` links the new workspace package.

### Phase 2: Implement test-facing GateCall.allow()

Make `new Gatekeeper().add(...).build()` return a harness whose methods return `GateCall` objects. `allow()` runs the real implementation and returns its result. `await` on a `GateCall` is a no-op, matching the Notion sketch.

```ts
const harness = new Gatekeeper()
	.add("server", () => new Server())
	.build()

const addOneCall = await harness.server.addOne(1)
expect(await addOneCall.allow()).toBe(2)
```

- [x] Implement immutable `add(name, factory)` that records factories in registration order.
- [x] Throw `DuplicateServiceError` when `add()` reuses a service name.
- [x] `build()` constructs each service by calling its factory with previously built service proxies.
- [x] Test-facing method calls return a `GateCall` without running the implementation.
- [x] `GateCall.allow()` runs the underlying async method with the captured `args` and resolves with its result.
- [x] Add a test that `allow()` on `server.addOne(1)` returns `2`.

### Phase 3: Add mockReturnValue, fail, and double-settle errors

Give tests a way to skip or break a call without running it, and fail fast if they settle the same call twice.

```ts
const skipped = await harness.server.addOne(1)
expect(await skipped.mockReturnValue(99)).toBe(99)

const failed = await harness.server.addOne(1)
await expect(failed.fail(new Error("boom"))).rejects.toThrow("boom")
```

- [x] Implement `mockReturnValue(value)` so the implementation does not run and the call resolves to `value`.
- [x] Implement `fail(error)` so the call's returned promise rejects with `error`.
- [x] Throw `CallAlreadySettledError` if `allow()`, `mockReturnValue()`, or `fail()` runs on a call that is already started or settled.
- [x] Add a test that `mockReturnValue()` does not increment an implementation counter.
- [x] Add a test that `fail()` rejects with the given error.
- [x] Add a test that settling the same call twice throws `CallAlreadySettledError`.

### Phase 4: Pause inter-service calls behind nextCall()

Factories for later services receive proxies. Those proxies implement the original async methods, but each invocation pauses until the test settles it. `harness.nextCall()` yields the next pending inter-service `GateCall` in FIFO order.

```ts
const resultPromise = (await harness.client.addOneThroughServer(1)).allow()
const serverCall = await harness.nextCall()
expect(serverCall.service).toBe("server")
expect(serverCall.args).toEqual([1])
await serverCall.allow()
expect(await resultPromise).toBe(2)
```

- [x] Pass proxies (not raw instances) into later factories so `client` calling `server.addOne()` creates a pending `GateCall`.
- [x] Inter-service proxies return `Promise<Result>` (the service's real async API), not `GateCall`.
- [x] `harness.nextCall()` resolves immediately when a matching call is already queued, otherwise waits until one arrives.
- [x] Test-facing calls do not appear in `nextCall()`. Only service-to-service hops do.
- [x] Add a test that the client call stays pending until the nested server call is allowed.
- [x] Add a test that mocking the nested server call makes the client observe the mocked value.
- [x] Add a test that failing the nested server call rejects the client call.
- [x] Add a test that two pending nested calls are returned by `nextCall()` in FIFO order.

### Phase 5: Lock the public TypeScript inference API

Cover the types a consumer actually sees: accumulated services on the builder, gated harness methods, and `GateCall` argument/result types.

```ts
const harness = new Gatekeeper()
	.add("server", () => new Server())
	.add("client", ({ server }) => new Client(server))
	.build()

type ClientCall = ReturnType<typeof harness.client.addOneThroughServer>
type _ExpectResult = Assert<
	TestIsEqual<ReturnType<ClientCall["allow"]>, Promise<number>>
>
```

- [x] Infer `harness.server` and `harness.client` from `add()` names.
- [x] Infer `GateCall` args from the service method parameters and the result from `Awaited<ReturnType>`.
- [x] Type factory `deps` so `({ server }) => new Client(server)` type-checks without a manual annotation.
- [x] Add `packages/gatekeeper/test/Gatekeeper.types.ts` assertions for the harness and `GateCall` types.
- [x] Verify `pnpm --filter @tanishqkancharla/tandem-gatekeeper type-check` and `pnpm --filter @tanishqkancharla/tandem-gatekeeper test` pass.
