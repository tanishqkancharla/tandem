# Gatekeeper

Gatekeeper is a proposed generic test harness for controlling execution order and
faults between services. This package contains the public API scaffold and tests
for review. The runtime is intentionally unimplemented: `add()` and `build()`
throw, and the operation controls are interface declarations.

The package has no runtime dependencies and no dependency on Tandem. Its tests use
small real services defined in [test/services.ts](test/services.ts).

## Read the tests first

[test/Gatekeeper.spec.ts](test/Gatekeeper.spec.ts) describes the proposed behavior.
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

## Proposed completion contract

| API | Completion point |
| --- | --- |
| `await client.method(...)` | The real operation completes, with its real result or rejection. |
| `await client.method(...).hold()` | Local work, including async preparation, reaches its first outgoing call to another registered service. That call is held before the receiver processes it. |
| `await call.continueUntil({ beforeProcessedBy: service })` | The next matching event is ready, but the service has not processed it. |
| `await call.continueUntil({ afterProcessedBy: service })` | The service processes that event, but its response remains undelivered. |
| `await call.continue()` | This call's holds are released and its original operation completes. |
| `await call.fail(error)` | The held interaction rejects; the real caller handles that rejection and determines the operation's result. |

An after-processing failure preserves the receiver's completed effects. An
application that catches the injected rejection can return an error value or a
recovery result; Gatekeeper must preserve that outcome. Unexpected unhandled
rejections also remain rejections.

Requesting the boundary where a call is already held leaves it in place and
resolves immediately. Progression leaves other calls' holds intact. `hold()` and
`continueUntil()` wait for real
dependencies until the requested boundary is reached. Gatekeeper does not detect
dependency deadlocks; a test that never releases a required gate reaches the
ordinary test timeout.

For example, when a client queues its second write behind the first response:

```ts
const secondReady = client1.write(20).hold()
await first.continue()
const second = await secondReady
await second.continue()
```

Detectable misuse rejects with a descriptive test-control error:

- `hold()` rejects if the operation completes without an outgoing service call.
  Returning to the test is not an external service call. Local effects already
  performed remain real.
- `continueUntil()` rejects if the operation completes without reaching its
  requested boundary. Effects performed while advancing remain real.
- Controls on a completed call reject instead of repeating or silently ignoring
  the action.

An operation that rejects before its first outgoing call preserves its original
rejection. Dependency waits alone are not evidence of misuse or a deadlock.

The harness is disposable so a failed test can abandon held work without leaking
it into another test. Disposal behavior is part of the future runtime, not
implemented by this scaffold.

## Run checks

From the repository root:

```sh
pnpm --filter @tanishqkancharla/gatekeeper type-check
pnpm --filter @tanishqkancharla/gatekeeper build
pnpm --filter @tanishqkancharla/gatekeeper test
```

The test command runs the runtime contract tests. They are expected to fail at
the unimplemented methods until the runtime is built. Compile-only
consumer tests in [test/Gatekeeper.types.ts](test/Gatekeeper.types.ts) are checked
by `type-check`, including method arguments, result types, builder dependencies,
and valid boundary selectors.

## Questions for implementation

The tests establish the desired public behavior without choosing the scheduler
implementation. In particular, the queued-call test requires reliable attribution
through async work. A plain proxy is not assumed to discover this automatically.
Shared batches must remain indivisible; the runtime cannot release a held action
as a side effect of advancing another one.

The example client deliberately serializes writes but allows independent reads.
These are actual properties of that example, not concurrency manufactured by
Gatekeeper. Services with different dependencies may need other operations to
progress before they can reach the same requested boundary.

Clock control, retries, background notifications, shared batching, and real
network transports remain outside this first contract suite. They need explicit
semantics and tests before support can be claimed.

The initial proxy typing covers ordinary, non-overloaded async methods. Generic
method correlations and overloaded signatures need a separate type design; the
current mapped type does not preserve them. This does not constrain Gatekeeper
to a particular application domain.
