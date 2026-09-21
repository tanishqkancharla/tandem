# Gatekeeper

Gatekeeper controls execution order and faults between real in-process services
in Node.js tests. It observes calls made through injected service proxies and can
pause them before a receiver runs or before its result returns to the caller.

## Construct a harness

Register services in dependency order. Factories receive previously registered
services with their ordinary interfaces.

```ts
await using harness = new Gatekeeper()
	.add("store", () => new Store())
	.add("server", ({ store }) => new Server(store))
	.add("client1", ({ server }) => new Client(server))
	.add("client2", ({ server }) => new Client(server))
	.build()
```

Gates begin deactivated, so setup calls run to completion without pausing. Every
asynchronous harness call still returns a `CallHandle`; while gates are inactive,
that handle is already settled. Activate gates immediately before the action
under test:

```ts
await harness.activateGates()

const call = await harness.client1.save(10)

call.assertSentBy("client1").assertWaitingFor("server")
```

The services remain real and stateful. Gatekeeper only controls communication
between their registered proxies.

## Step through a call

`continueTo(name)` delivers the current handoff to that service and advances
until the call reaches its next gate or completes.

```ts
const call = await harness.client1.save(10)

call.assertSentBy("client1").assertWaitingFor("server")

await call.continueTo("server")
call.assertSentBy("server").assertWaitingFor("store")

await call.continueTo("store")
call.assertSentBy("store").assertWaitingFor("server")

await call.continueTo("server")
call.assertSentBy("server").assertWaitingFor("client1")

await call.continueTo("client1")
call.assertCompleted()
expect(await call.result).toBe(10)
```

Use `continueToCompletion()` when intermediate boundaries are irrelevant. It
releases this call without releasing independent calls.

```ts
await call.continueToCompletion()

call.assertCompleted()
expect(await call.result).toBe(10)
```

`result` is the original public operation's result. It retains application
return values and rejection identity.

## Inject a failure

`fail(error)` rejects the current handoff. The real caller receives that
rejection and runs its ordinary recovery behavior.

```ts
const call = await harness.client1.save(10)
const failure = new Error("Server is unreachable")

await call.fail(failure)

call.assertCompleted()
await expect(call.result).rejects.toBe(failure)
```

Failing an exit gate preserves effects the receiving service already completed.

## Configure service gates

Services gate entry and exit by default. Configure either direction when a
service supplies an event rather than a request-response boundary.

| Configuration  | Behavior                                                             |
| -------------- | -------------------------------------------------------------------- |
| `enter: true`  | Pause before the service processes the call.                         |
| `enter: false` | Let the service begin immediately and observe its real pending work. |
| `exit: true`   | Pause a settled result before returning it to the caller.            |
| `exit: false`  | Deliver the settled result immediately.                              |

A manually controlled timer is an ordinary service with both synthetic gates
disabled. Its unresolved promise is still visible as the client's current wait.

```ts
class ManualTimer {
	private nextTick?: PromiseWithResolvers<void>

	waitForNextTick() {
		this.nextTick = Promise.withResolvers<void>()
		return this.nextTick.promise
	}

	async fire() {
		const nextTick = this.nextTick
		this.nextTick = undefined
		nextTick?.resolve()
		await Promise.resolve()
	}
}

const harness = new Gatekeeper()
	.add("client1Timer", () => new ManualTimer(), {
		gates: { enter: false, exit: false },
	})
	.add(
		"client1",
		({ server, client1Timer }) => new Client({ server, timer: client1Timer }),
	)
	.build()
```

```ts
const call = await harness.client1.save(10)

call.assertSentBy("client1").assertWaitingFor("client1Timer")

await harness.client1Timer.fire()

call.assertSentBy("client1").assertWaitingFor("server")
```

Each client can receive its own timer service, so firing one client's timer does
not advance another client's work.

## Lifecycle

`deactivateGates()` releases current synthetic gates and lets subsequent calls
run to settled handles without pausing. `deactivateGatesAndSettle()` additionally
waits for active calls to finish. A real unresolved dependency, such as a manual
timer that has not fired, must still be resolved by its owner.

Disposing a harness rejects its active calls without delivering held requests or
undoing completed effects. Service resources remain owned by their caller.

## Runtime and type contract

Synchronous service methods remain synchronous observations. Every asynchronous
test-facing call returns a `CallHandle<Result>`. With gates active, the handle is
returned when the call reaches its first controlled boundary. With gates
inactive—or when an active call completes without a service handoff—the returned
handle is already settled. The operation's value or rejection is always exposed
through `call.result`.

Calls between registered services must return promises. Direct calls through raw
service references bypass Gatekeeper. Async context associates nested service
calls with their originating public operation.

Gatekeeper requires Node.js 22 or later.

## Checks

Run from the repository root:

```sh
pnpm --filter @tanishqkancharla/gatekeeper type-check
pnpm --filter @tanishqkancharla/gatekeeper build
pnpm --filter @tanishqkancharla/gatekeeper lint
pnpm --filter @tanishqkancharla/gatekeeper test
```

The runtime contract lives in [`test/Gatekeeper.spec.ts`](test/Gatekeeper.spec.ts).
Compile-only consumer inference checks live in
[`test/Gatekeeper.types.ts`](test/Gatekeeper.types.ts).
