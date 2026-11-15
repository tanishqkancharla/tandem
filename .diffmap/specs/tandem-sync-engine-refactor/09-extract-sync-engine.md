# Phase 4: Split TandemServer into TandemBackend and TandemSyncEngine

[Phase 2](07-remove-live-payloads.md) made pokes carry no data and [Phase 3](08-pull-after-push.md) stopped poking the pusher. What is left of the server's live code is connections and per-collection filtering. This phase moves it into `TandemSyncEngine`, renames the rest `TandemBackend`, and keeps the name `TandemServer` for the two bundled in one process ([Target architecture](02-target-architecture.md#three-pieces-and-one-bundle)). The backend reaches the sync engine only through `TandemPublisher` ([Library API](03-library-api.md#server-side)). Behavior stays the same.

**Today**

`TandemServer` implements `connect` and holds `syncClients` ([[packages/server/src/TandemServer.ts#TandemServer.connect]]). The event stream response registers with the server directly. The client's sync loop is a class called `SyncEngine`.

**Proposed**

Apps on a long-lived host keep writing `new TandemServer(...)` and connect the event stream route to `server.engine`. Clients see the same events. Apps that want the pieces apart create a `TandemBackend` with a publisher. The client's class becomes `TandemClientSync`, so the docs can say "sync engine" without ambiguity.

```ts
const server = new TandemServer({ schema, relations, storage, mutators })

app.post("/api/tandem", (c) => handleTandemRequest(server.backend, c.req.raw))
app.get("/api/tandem/events", (c) =>
	createTandemEventStreamResponse({ engine: server.engine, clientId, signal: c.req.raw.signal }),
)
```

`TandemServer` is a thin class:

```ts
export class TandemServer<Schema, Relations, Mutators, RequestContext> {
	readonly engine: TandemSyncEngine
	readonly backend: TandemBackend<Schema, Relations, Mutators, RequestContext>

	constructor(args: Omit<TandemBackendArgs<Schema, Relations, Mutators, RequestContext>, "publisher"> & { pokeInterval?: number }) {
		this.engine = new TandemSyncEngine({ pokeInterval: args.pokeInterval })
		this.backend = new TandemBackend({ ...args, publisher: this.engine })
	}
}
// [!note publisher] In one process the engine is the publisher, so publishing is a function call.
```

Inside the backend, the commit path shrinks to one publish:

```callstack [commitTransaction]
 TandemServer.commitTransaction(tx, options) [[packages/server/src/TandemServer.ts#TandemServer.commitTransaction]]
 ├── commit writes
 ├── collections = collections of every written or removed record
-└── emitLivePokes(collections) # per-client loop in the server
+└── publisher?.publish({ channels: [...collections] }) # after commit
```

Inside the sync engine, the loop that was `emitLivePokes` keys connections by channel instead of by client dependencies:

```ts
class TandemSyncEngine implements TandemPublisher {
	private readonly channels = new Map<string, Set<Connection>>()

	async publish({ channels }: TandemCommitEvent) {
		const poked = new Set<Connection>()
		for (const channel of channels)
			for (const connection of this.channels.get(channel) ?? []) poked.add(connection)
		for (const connection of poked) connection.poke() // at most once per pokeInterval
	}
	// connect(), setChannels(), close() manage this.channels
}
```

In this phase the backend still sets channels itself, since pulls do not yet return grants: after each pull, the backend calls `engine.setChannels(clientId, collections read)`, as `readPull` stores `dependencies` today. [Phase 5](10-channels.md) moves that to the client.

The event stream moves to the new `@tanishqkancharla/tandem-sync` package. `TandemBackend` does not implement `RemoteApi.connect`; the storage `subscribe` hook publishes every collection instead of poking every client.

Tests: the live poke and event stream specs ([[packages/server/test/LivePokes.spec.ts]], [[packages/server/test/LiveEventStream.spec.ts]], [[packages/server/test/TandemEventStream.spec.ts]]) move to the sync package and run against `TandemServer`. The package `@tanishqkancharla/tandem-server` becomes `@tanishqkancharla/tandem-backend`, and `TandemServerTransaction` and `TandemServerStorageApi` take the `TandemBackend` prefix. `dst/` models the engine as its own actor, even in process, so later phases can separate it.

```changes

```
