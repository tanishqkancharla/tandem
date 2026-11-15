# Phase 4: Extract the sync engine from TandemServer

[Phase 2](07-remove-live-payloads.md) made pokes carry no data and [Phase 3](08-pull-after-push.md) stopped poking the pusher. What is left of the server's live code is connections and per-collection filtering. This phase moves it into `TandemSyncEngine`, which the server reaches only through `TandemPublisher` ([Library API](03-library-api.md#server-side)). Behavior stays the same: this is mode 1 with the pieces separated.

**Today**

`TandemServer` implements `connect` and holds `syncClients` ([[packages/server/src/TandemServer.ts#TandemServer.connect]]). The event stream response registers with the server directly. The client's sync loop is a class called `SyncEngine`.

**Proposed**

Apps create a `TandemSyncEngine`, pass it to the server as its publisher, and give it to the event stream route. Clients see the same events. The client's class becomes `TandemClientSync`, so the docs can say "sync engine" without ambiguity.

```ts
const engine = new TandemSyncEngine()
const server = new TandemServer({ schema, relations, storage, mutators, publisher: engine })

app.get("/api/tandem/events", (c) =>
	createTandemEventStreamResponse({ engine, clientId, signal: c.req.raw.signal }),
)
```

The commit path shrinks to one publish:

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

In this phase the server still sets channels itself, since pulls do not yet return grants: after each pull, the server calls `engine.setChannels(clientId, collections read)`, as `readPull` stores `dependencies` today. [Phase 5](10-channels.md) moves that to the client.

The event stream moves to the new `@tanishqkancharla/tandem-sync` package. `TandemServer` stops implementing `RemoteApi.connect`; the storage `subscribe` hook publishes every collection instead of poking every client.

Tests: the live poke and event stream specs ([[packages/server/test/LivePokes.spec.ts]], [[packages/server/test/LiveEventStream.spec.ts]], [[packages/server/test/TandemEventStream.spec.ts]]) move to the sync package and run against server plus engine. `dst/` models the engine as its own actor, even in process, so later phases can separate it.

```changes

```
