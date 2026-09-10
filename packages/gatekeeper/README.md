# Gatekeeper

Gatekeeper controls execution order and faults between services in Node.js tests.
Tests drive real service methods and pause their outgoing calls by service identity.

The package requires Node.js 22 or later and has no dependency on Tandem. Its tests
use small real services defined in [test/services.ts](test/services.ts).

## Read the tests first

[test/Gatekeeper.spec.ts](test/Gatekeeper.spec.ts) describes the ordering contract.
The tests call services directly, select processing boundaries by service identity,
and assert visible values and save status. They never select an internal RPC name.

```ts
const first = await client1.write(10).hold()
const second = await client2.write(20).hold()

await second.continueUntil({ afterProcessedBy: server })
await first.continueUntil({ afterProcessedBy: server })

await second.continue()
await first.continue()
```

Factories receive previously registered services with their ordinary interfaces.
The test receives proxies: async calls return awaitable operations, while
synchronous observations remain synchronous.

```ts
await using harness = new Gatekeeper()
  .add("server", () => new Server())
  .add("client1", ({ server }) => new Client(server))
  .add("client2", ({ server }) => new Client(server))
  .build()

const { client1, client2, server } = harness
```

## Completion contract

| API | Completion point |
| --- | --- |
| `await client.method(...)` | The real operation completes, with its real result or rejection. |
| `await client.method(...).hold()` | Local work, including async preparation, reaches its first outgoing call to another registered service. That call is held before the receiver processes it. |
| `await call.continueUntil({ beforeProcessedBy: service })` | The next matching event is ready, but the service has not processed it. |
| `await call.continueUntil({ afterProcessedBy: service })` | The service processes that event, but its response remains undelivered. |
| `await call.continue()` | This call's holds are released and its original operation completes. |
| `await call.fail(error)` | The held interaction rejects; the real caller handles that rejection and determines the operation's result. |

Call `.hold()` immediately on the returned operation, before awaiting anything
else. It arms the outgoing gates synchronously, then waits for the first handoff.
Otherwise the operation runs normally. Awaiting a normally consumed operation
again returns the same result without executing it again.

An after-processing failure preserves the receiver's completed effects. An
application that catches the injected rejection can return an error value or a
recovery result; Gatekeeper must preserve that outcome. Unexpected unhandled
rejections also remain rejections.

Requesting the boundary where a call is already held leaves it in place and
resolves immediately. Progression leaves other calls' holds intact. `hold()` and
`continueUntil()` wait for real dependencies until the requested boundary is
reached. Gatekeeper does not detect
dependency deadlocks; a test that never releases a required gate reaches the
ordinary test timeout.

For example, when a client queues its second write behind the first response:

```ts
const secondReady = client1.write(20).hold()
await first.continue()
const second = await secondReady
await second.continue()
```

Detectable misuse rejects with a descriptive `GatekeeperError`, exported from the
package entry point:

- `hold()` rejects if the operation completes without an outgoing service call.
  Returning to the test is not an external service call. Local effects already
  performed remain real.
- `continueUntil()` rejects if the operation completes without reaching its
  requested boundary. Effects performed while advancing remain real.
- Controls on a completed call reject instead of repeating or silently ignoring
  the action.
- Holding an already consumed operation, overlapping controls, or choosing a
  service from another harness rejects without advancing the held request.

An operation that rejects before its first outgoing call preserves its original
rejection. Dependency waits alone are not evidence of misuse or a deadlock.

Ordinary calls preserve the early completion behavior of `Promise.all()` and
`Promise.race()`; remaining requests keep running. If a held operation completes
with other requests still gated, those gates stay in place until disposal.
Completed handles cannot release them. Calling `continue()` or `fail()` before
completion releases the operation's remaining gates as part of that control.

The harness owns its gates, not the service instances. Disposal rejects pending
controls and intercepted requests without delivering held requests or undoing
completed effects. It is safe to dispose more than once. Callers manage their own
service resources, timers, and background work; disposal cannot cancel arbitrary
JavaScript already executing inside a service.

## Run checks

From the repository root:

```sh
pnpm --filter @tanishqkancharla/gatekeeper type-check
pnpm --filter @tanishqkancharla/gatekeeper build
pnpm --filter @tanishqkancharla/gatekeeper lint
pnpm --filter @tanishqkancharla/gatekeeper test
```

The test command runs the ordering and [lifecycle tests](test/lifecycle.spec.ts).
Compile-only consumer tests in [test/Gatekeeper.types.ts](test/Gatekeeper.types.ts) are checked
by `type-check`, including method arguments, result types, builder dependencies,
and valid boundary selectors.

## Scope

Factories run synchronously and receive dependency proxies with ordinary service
types. Methods use their real instances as `this`, including private fields.
Synchronous observations and properties remain available directly from tests.
Calls between registered services must return promises. A synchronous dependency
method produces a control error when invoked; its synchronous effects cannot be
rolled back. Own methods that are both non-configurable and non-writable cannot
be proxied and produce a descriptive error.

Node's async context associates each intercepted call with its originating
operation. Gates control calls made through the injected proxies. Direct calls
through raw service references bypass interception. Promise-returning methods and
their awaited work are the supported unit of execution; detached background work
and batches shared across separate operations have no scheduling contract.

The example client deliberately serializes writes but allows independent reads.
These are actual properties of that example, not concurrency manufactured by
Gatekeeper. Services with different dependencies may need other operations to
progress before they can reach the same requested boundary.

Gatekeeper provides no clock control or network transport interception. Services
may wrap network transports themselves, but the gates surround service calls.

The initial proxy typing covers ordinary, non-overloaded async methods. Generic
method correlations and overloaded signatures need a separate type design; the
current mapped type does not preserve them. This does not constrain Gatekeeper
to a particular application domain.
