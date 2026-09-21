# Services

A service is a stateful runtime object, implemented as a class. A host supplies environment capabilities, configuration, and lifecycle. An adapter connects a service to a platform or consumer. Prefer composition over inheritance.

## Start with the consumer's operation

Judge boundaries by the path from a consumer action to its visible result. Prefer direct flows over chains that bounce between services.

JavaScript clients, React bindings, server adapters, and development tools should reach the same Tandem operations with the same validation, state changes, and events. Their transports may differ; they should not bypass the operation's owning service.

## Give dependencies an owner and a lifetime

A composed service owns its children. Place a shared child at the lowest common owner that needs it. For example, subscriptions and synchronization can share one database and its transaction coordination:

```ts
// Avoid: separate storage instances for services acting on one database.
const subscriptions = new SubscriptionService({
  database: new Database({ storage }),
});
const sync = new SyncService({
  database: new Database({ storage }),
});
```

Instead, construct the shared dependency once in the owning host:

```ts
// Prefer: both services borrow the database owned by the host.
const database = new Database({ storage });
const subscriptions = new SubscriptionService({ database });
const sync = new SyncService({ database });
```

The host opens the database before its consumers and closes them before the database. Both consumers borrow it; the host owns its lifetime. Sharing is not a reason to move the database into a process-global singleton.

Use a constructor for synchronous setup and `start()` or `create()` for fallible asynchronous setup. Construct children in dependency order and register cleanup as resources are acquired, including during failed startup. `using` or `await using` with disposable stacks keeps reverse-order cleanup together with acquisition.

## Let the host supply the environment

Define narrow, service-owned interfaces where filesystem, network, time, or platform access varies by host. Hosts implement and supply those capabilities. Share a service when behavior above an interface needs state; do not mirror every third-party API or wrap deterministic helpers.

The host owns its private bridges. Callers supply configuration, not the transport bridge that the host should construct. Importing a reusable package must not read deployment configuration, touch disk, or start services.

## Keep authority boundaries explicit

Trusted development control and test setup must not grant ordinary consumers extra authority. Prefer public consumer operations for setup. When an explicit test-only capability is necessary, gate it at construction or startup, keep it disabled by default, and keep assertions on the ordinary public result.
