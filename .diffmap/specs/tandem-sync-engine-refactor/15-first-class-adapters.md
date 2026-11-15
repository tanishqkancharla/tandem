# Phase 10: Adapters for Durable Objects, Next.js, and Rivet

Phases [4](09-extract-sync-engine.md) to [8](13-hosted-pub-sub.md) built the pieces: a stateless backend, an in-process or standalone sync engine, and hosted pub/sub. This phase packages them for three hosts, so an app on each writes a few lines instead of the request parsing and routing every example copies today. Each adapter could be its own commit; they share this page because they share the shape.

**Today**

The Cloudflare example hand-writes request decoding, routing, and a remote ([[examples/cloudflare/apps/server/src/index.ts]], [[examples/cloudflare/apps/server/src/remote.ts#createRemote]]). Next.js and Rivet apps have no guide.

**Proposed**

Each host gets one server-side helper and one client-side transport. The request envelope and codecs move into a shared `handleTandemRequest(backend, request)`, which the adapters and the existing examples use.

```callstack [handleTandemRequest]
+response = handleTandemRequest(backend, request, { context })
+├── body = decode { action, args } # from validateRequest in the examples
+├── if action is push: decode with MutationApi.codec, backend.push(args, { context })
+├── if action is pull: backend.pull(args, { context })
+└── return Response.json(result)
```

## Durable Objects

A Durable Object is a single writer with its own SQLite, so it runs mode 1: one object per data scope holds a `TandemServer`, a backend and sync engine together. The adapter adds two things the example lacks:

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

### One object per room

An app such as a video editor with one object per room can run a `TandemServer` in each object. Nothing in the server stops it, and it scales well, since rooms share no locks. Four limits apply ([Target architecture](02-target-architecture.md#many-durable-objects-one-room-per-object)):

- **One client per room.** A `TandemClient` has one remote and numbers its mutations in one sequence; a server rejects a mutation whose ID skips ahead. A page that shows two rooms opens two clients.
- **Data outside rooms.** Users, projects, and room lists live in another scope: another object, or a `TandemBackend` on a shared database, with its own client.
- **Shared databases.** If rooms keep their rows in a shared D1 or Postgres rather than the object's SQLite, every write to a room's rows must go through that room's object, or its clients are not poked.
- **Fast writes.** Dragging a clip can push dozens of mutations a second. The client should throttle such writes, and `pokeInterval` caps how often other clients pull.

The adapter routes by room in `fetch`, and `createTandemRemote` takes the room's URL:

```ts
const client = new TandemClient({ schema, remote: createTandemRemote({ schema, url: `/rooms/${roomId}/tandem`, live: tandemWebSocket() }) })
```

### Sync engine only

A Durable Object can also serve as the sync engine for a backend elsewhere (mode 2): `createTandemSyncEngineObject()` exposes the [Phase 7](12-standalone-sync-engine.md) routes from an object.

## Next.js

Route handlers run per request, so Next.js runs `TandemBackend` with an external sync engine or a hosted service (modes 2 and 4). The backend object lives at module scope; a cold start costs nothing beyond its database connection.

```ts
// app/api/tandem/route.ts
import { createTandemNextHandler } from "@tanishqkancharla/tandem-backend/next"

export const { POST } = createTandemNextHandler({
	backend, // TandemBackend with a Postgres storage, a publisher, and grants
	context: async (request) => auth(request), // returns the session, or a Response to refuse
})
```

```tsx
// app/providers.tsx
const remote = createTandemRemote({ schema, url: "/api/tandem", live: ablyLive({ realtime }) })
```

A new `examples/next` app uses PGlite locally and the Phase 7 sync engine, with Playwright tests like the todo example's.

## Rivet

A Rivet actor, like a Durable Object, is a long-lived single writer with persistent state, so it runs mode 1 with a `TandemServer`. Rivet also carries realtime events over its own client connections, so the live transport is the actor connection rather than SSE. The sketch below shows the shape; exact RivetKit names need checking when the phase starts:

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
