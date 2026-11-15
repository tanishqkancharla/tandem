# Phase 10: Adapters for Durable Objects, Next.js, and Rivet

Phases [4](09-extract-sync-engine.md) to [8](13-hosted-pub-sub.md) built the pieces: a stateless server, an in-process or standalone sync engine, and hosted pub/sub. This phase packages them for three hosts, so an app on each writes a few lines instead of the request parsing and routing every example copies today. Each adapter could be its own commit; they share this page because they share the shape.

**Today**

The Cloudflare example hand-writes request decoding, routing, and a remote ([[examples/cloudflare/apps/server/src/index.ts]], [[examples/cloudflare/apps/server/src/remote.ts#createRemote]]). Next.js and Rivet apps have no guide.

**Proposed**

Each host gets one server-side helper and one client-side transport. The request envelope and codecs move into a shared `handleTandemRequest(server, request)`, which the adapters and the existing examples use.

```callstack [handleTandemRequest]
+response = handleTandemRequest(server, request, { context })
+├── body = decode { action, args } # from validateRequest in the examples
+├── if action is push: decode with MutationApi.codec, server.push(args, { context })
+├── if action is pull: server.pull(args, { context })
+└── return Response.json(result)
```

## Durable Objects

A Durable Object is a single writer with its own SQLite, so it runs mode 1: one object per data scope holds the server and an in-process sync engine. The adapter adds two things the example lacks:

- **Durable Object SQLite storage.** `ctx.storage.sql` with `transactionSync` gives the interactive transactions from [Phase 6](11-stateless-pulls.md) inside the object, without D1's batch-only limit.
- **Hibernatable WebSockets.** SSE keeps the object awake; `ctx.acceptWebSocket` lets it sleep between messages. Each socket stores its client ID and channels with `serializeAttachment`, so a publish after waking finds them. Tags fix at accept time, so channels live in the attachment, not in tags.

```ts
export class TandemObject extends createTandemDurableObject({
	server: (ctx, env) => ({ schema, relations, mutators, storage: durableObjectSqlStorage(ctx, schema) }),
	transport: "websocket", // or "sse"
}) {}

export default {
	fetch: (request: Request, env: Env) =>
		env.TANDEM.getByName(workspaceFrom(request)).fetch(request), // one object per scope
}
```

A Durable Object can also serve as the sync engine for a server elsewhere (mode 2): `createTandemSyncEngineObject()` exposes the [Phase 7](12-standalone-sync-engine.md) routes from an object.

## Next.js

Route handlers run per request, so Next.js runs the stateless server with an external sync engine or a hosted service (modes 2 and 4). The server object lives at module scope; a cold start costs nothing beyond its database connection.

```ts
// app/api/tandem/route.ts
import { createTandemNextHandler } from "@tanishqkancharla/tandem-server/next"

export const { POST } = createTandemNextHandler({
	server, // TandemServer with a Postgres storage, a publisher, and grants
	context: async (request) => auth(request), // returns the session, or a Response to refuse
})
```

```tsx
// app/providers.tsx
const remote = createTandemRemote({ schema, url: "/api/tandem", live: ablyLive({ realtime }) })
```

A new `examples/next` app uses PGlite locally and the Phase 7 sync engine, with Playwright tests like the todo example's.

## Rivet

A Rivet actor, like a Durable Object, is a long-lived single writer with persistent state, so it runs mode 1. Rivet also carries realtime events over its own client connections, so the live transport is the actor connection rather than SSE. The sketch below shows the shape; exact RivetKit names need checking when the phase starts:

```ts
export const tandem = actor({
	createState: () => ({}),
	createVars: (c) => tandemActorVars(c, { schema, relations, mutators, storage }),
	actions: {
		push: (c, args) => c.vars.server.push(args),
		pull: (c, args) => c.vars.server.pull(args),
		setChannels: (c, grant) => c.vars.engine.setChannels(c.conn, grant),
	},
})

// client
const live = rivetLive({ actor: client.tandem.getOrCreate([workspaceId]) }) // pokes arrive as actor events
```

Storage is the actor's SQLite when available, or an external Postgres.

## Tests

Each adapter has a contract test that runs the shared sync scenarios through it: Miniflare for Durable Objects, as the Cloudflare example's test does today, Next's route handler called directly, and Rivet's test harness. The Cloudflare example moves onto the adapter, which is how we know the adapter covers it.

```changes

```
