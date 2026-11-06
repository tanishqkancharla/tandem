# Add Tandem to an existing API server

Run `TandemServer` inside your existing backend and mount its sync routes alongside your application routes. You do not need a separate HTTP server or a new port. This guide uses Hono; the same calls work in frameworks that accept standard `Request` and `Response` objects.

## Create one Tandem server

Install the libraries in your backend:

```sh
pnpm add @tanishqkancharla/tandem-core @tanishqkancharla/tandem-server
```

Create the instance at application startup, using your shared schema and mutations and a [storage adapter](sql.md). Reuse it across requests so its mutation queue and live connections have one owner:

```ts
// tandem.ts
import { TandemServer } from "@tanishqkancharla/tandem-server"
import { schema, mutators } from "./shared"
import { storage } from "./storage"

export const tandem = new TandemServer({
	schema,
	relations: {},
	storage,
	mutators,
})
```

`storage` can use the database pool your app already owns. The SQL adapters are experimental and keep mutation acknowledgements in memory; see [SQL limitations](sql.md#sql-limitations).

## Mount the sync routes

Add these handlers to your existing Hono `app`. The example assumes your authentication middleware exposes a session, and that the caller may read all records in this Tandem instance's data scope. For workspace isolation or finer access, use the [permissions setup](permissions.md) before delegating to the server.

```ts
import { tag, type ClientId } from "@tanishqkancharla/tandem-core"
import { createTandemEventStreamResponse } from "@tanishqkancharla/tandem-server"
import { schema } from "./shared"
import { tandem } from "./tandem"

const eventStreams = new AbortController()

app.post("/api/tandem", async (c) => {
	const input = await readSyncRequest(c.req.raw)
	if (input instanceof Error) return c.json({ error: "invalid-request" }, 400)
	const session = c.get("session")
	const denied = await checkSyncAccess({ session, input })
	if (denied instanceof Error) return c.json({ error: "forbidden" }, 403)

	if (input.action === "push") {
		return c.json(
			await tandem.push(input.args, {
				context: session,
				allowOps: false,
			}),
		)
	}
	return c.json(await tandem.pull(input.args))
})

app.get("/api/tandem/events", async (c) => {
	const id = c.req.query("clientId")
	if (!id) return c.json({ error: "invalid-request" }, 400)
	const session = c.get("session")
	const denied = await checkSyncAccess({ session, clientId: id })
	if (denied instanceof Error) return c.json({ error: "forbidden" }, 403)

	return createTandemEventStreamResponse({
		remote: tandem,
		clientId: tag<ClientId>(id),
		schema,
		signal: AbortSignal.any([c.req.raw.signal, eventStreams.signal]),
	})
})
```

`readSyncRequest` and `checkSyncAccess` are application helpers. The first validates the `{ action, args }` envelope and decodes mutations before any push, as described in [Transport codecs](server.md#transport-codecs); it returns a `push` or `pull` request. The second rejects missing sessions, checks client ID ownership and access to this instance's data, and validates every pull query against the caller's read scope. Reuse the same checks for event connections. The [todo server source](https://github.com/tanishqkancharla/tandem/blob/main/examples/todo/apps/server/src/app.ts) shows request parsing, as `validateRequest`, and route wiring. It checks only the envelope and has no authentication.

Register server-only mutation hooks for write permissions. `allowOps: false` blocks raw operation mutations; it does not add permission checks to named mutations. The `session` passed to `push` reaches your hooks factory. See [Mutations](mutations.md#server-hooks).

## Connect the frontend

Use the [Quickstart HTTP transport](quickstart.md#5-add-a-server) with `/api/tandem` and `/api/tandem/events`. Serve them from the app's origin, or proxy both paths during development. The event route must support streaming responses; configure your proxy to avoid buffering SSE.

Subscribe to queries before expecting another client's matching records. Backend jobs should write through this Tandem server too, so connected clients receive notifications.

## Shutdown and deployment

On shutdown, stop accepting new requests and call `eventStreams.abort()` to end open streams. Drain in-flight handlers, then call `await tandem.close()` before closing application-owned database pools. Live streams can otherwise keep shutdown waiting. End streams on access revocation too; the permissions guide describes per-connection abort signals.

Keep requests and event connections for a data scope on the same long-lived instance. Several API workers or replicas do not automatically share Tandem's mutation queue, acknowledgements, or live notifications. Route that scope to one owner; adding these routes independently to every replica is not a shared sync service. The [Cloudflare guide](cloudflare.md) uses a Durable Object as that owner.

For schema changes during deployment, follow [Schema changes and client compatibility](migrations.md).
