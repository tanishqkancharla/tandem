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

## Inspect pending calls

`pendingCalls()` lists every call currently held at an enter or exit gate, in
the order the calls started. Each entry carries the call's handle and the
boundary it can be advanced from, so a driver can choose what happens next
without keeping its own record of outstanding calls.

```ts
const first = await harness.client1.save(10)
const second = await harness.client2.save(20)
await first.continueTo("server")

harness.pendingCalls()
// [
//   { handle: first, label: "client1.save", sentBy: "server", waitingFor: "store" },
//   { handle: second, label: "client2.save", sentBy: "client2", waitingFor: "server" },
// ]
```

A call appears once, at its current boundary, because `continueTo` and `fail`
act only on that boundary. Completed calls, calls with a control in progress,
and work still processing inside a service without an enter gate are not listed.

## Deliver events

A service call is a request with a reply, and every handoff belongs to the call
that made it. Some messages instead start new work on another service, like a
server notifying clients of a change. Factories receive `events` for these.

```ts
class Client {
	private seen = 0
	private readonly changed: GatekeeperListener

	constructor(
		private readonly server: Server,
		events: GatekeeperEvents,
	) {
		// Owned by this client, because its factory is running.
		this.changed = events.on("changed", async () => {
			this.seen = await this.server.read()
		})
	}

	connect() {
		return this.server.subscribe(() => this.changed.emit())
	}
}

const harness = new Gatekeeper()
	.add("server", () => new Server())
	.add("client1", ({ server }, { events }) => new Client(server, events))
	.add("client2", ({ server }, { events }) => new Client(server, events))
	.build()
```

A listener belongs to the service whose factory registers it, or to the running
service when registered during a call. `emit()` returns immediately and starts a
new call labeled `<owner>.<name>`, held at the owner's enter gate. The emitting
service is its sender and never waits for or observes the outcome.

```ts
const save = await harness.client1.save(10)
await save.continueTo("server") // the server notifies both clients

harness.pendingCalls()
// [
//   { label: "client1.save",    sentBy: "server", waitingFor: "client1" },
//   { label: "client1.changed", sentBy: "server", waitingFor: "client1" },
//   { label: "client2.changed", sentBy: "server", waitingFor: "client2" },
// ]
```

`continueTo(owner)` runs the listener, and its service calls are gated inside the
event's call. `fail(error)` loses the event, so the listener never runs. Events
have no reply, so a listener's result is not held at the exit gate. While gates
are inactive, listeners run without pausing. Listeners must return promises, so
Gatekeeper knows when their work is done.

## Crash and restart a service

`crash(name)` kills a service's current instance at whatever point it has
reached, and `restart(name)` runs its factory again. The harness handle and every
dependency proxy then reach the new instance. Keep anything that must survive a
crash, such as durable storage, in its own service.

```ts
const save = await harness.client1.save(10)

await harness.crash("client1")
await save.continueTo("server") // the request was already sent, so it still arrives

await harness.restart("client1")
harness.client1.read() // a fresh instance
```

A crash applies these rules, so nothing waits on the dead instance:

| Handoff                                          | After the crash                                      |
| ------------------------------------------------ | ---------------------------------------------------- |
| A request the service already sent               | Still deliverable; its reply is dropped              |
| A request or event addressed to the service      | Fails with a crash error, like a refused connection  |
| A reply addressed to the service                 | Dropped                                              |
| Anything the dead instance calls afterwards      | Never settles and is not tracked                     |
| The service's own top-level calls                | Fail once no deliverable request remains in them     |

The dead instance's code can keep running in memory; it just cannot reach
anything. Calling a crashed service through the harness throws until it restarts.

## Configure service gates

Services gate entry and exit by default. Configure either direction when a
service supplies an event rather than a request-response boundary.

| Configuration  | Behavior                                                             |
| -------------- | -------------------------------------------------------------------- |
| `enter: true`  | Pause before the service processes the call.                         |
| `enter: false` | Let the service begin immediately and observe its real pending work. |
| `exit: true`   | Pause a settled result before returning it to the caller.            |
| `exit: false`  | Deliver the settled result immediately.                              |

A timer is an ordinary service. In tests it can resolve immediately while its
exit gate controls when the tick is delivered to the client.

```ts
class TestTimer {
	waitForNextTick() {
		return Promise.resolve()
	}
}

const harness = new Gatekeeper()
	.add("client1Timer", () => new TestTimer(), {
		gates: { enter: false, exit: true },
	})
	.add(
		"client1",
		({ server, client1Timer }) => new Client({ server, timer: client1Timer }),
	)
	.build()
```

```ts
const call = await harness.client1.save(10)

call.assertSentBy("client1Timer").assertWaitingFor("client1")

await call.continueTo("client1")

call.assertSentBy("client1").assertWaitingFor("server")
```

Each client can receive its own timer service, so delivering one client's tick
does not advance another client's work.

## Lifecycle

`deactivateGates()` releases current synthetic gates and lets subsequent calls
run to settled handles without pausing. `deactivateGatesAndSettle()` additionally
waits for active calls to finish. A real unresolved dependency must still be
resolved by its owner.

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
