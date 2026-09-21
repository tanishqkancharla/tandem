# State

The first question is who owns a value. Then decide how consumers observe it and which operations need ordering to change it safely.

## Put mutable state on its owner

Keep mutable runtime state on service instances, not in module globals or hidden singletons. Immutable module-level data is fine.

Avoid runtime clients shared by every instance:

```ts
const remote = createRemote();
let activeSubscription: Subscription | undefined;
```

Prefer state owned by each service instance:

```ts
class SyncHost {
  // Tracks this host's active subscription.
  private activeSubscription: Subscription | undefined;
  // Owns the remote used by this host.
  private readonly remote = createRemote();
}
```

Ownership also determines where persistent state belongs. Persist one authoritative copy of a value at its owning layer. Do not duplicate database state in a second hidden store merely because another consumer needs a different view.

## Derive the views consumers see

Represent consumer-visible mutable state as streams. Methods issue commands; streams publish state. Derive mapped or materialized views instead of keeping separately updated copies. A total derived from events illustrates the difference:

```ts
// Avoid: each write must remember to update both values.
source.append(value);
total += value;

// Prefer: a consumer derives its total from the event stream.
const totals = source.project(0, (sum, value) => sum + value);
```

Subscribe before emitting events; this projection is not a persisted store or a replay of events from before the subscription.

Not every field needs to be a stream. Internal queues, caches, and in-flight operations can remain ordinary private state when consumers do not observe them.

## Order changes without blocking control

Serialize only operations that require ordering, with coordination owned by the service or database that owns the affected state. Prefer Tandem's transaction and stream primitives when they already provide the required ordering. Do not build ad hoc promise chains or one global queue for unrelated state.

Keep public methods semantic, such as `commit()`, `sync()`, or `close()`. If a queued operation has a shared private implementation, name that implementation for its behavior and make already-coordinated callers invoke it directly rather than enqueue recursively.

An ordered operation must preserve its result or failure and allow later operations to continue after an expected failure. Long-running network calls and subscriptions must not block the coordination path needed to cancel or control them.
