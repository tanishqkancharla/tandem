# Deploy on Cloudflare

Run one `TandemServer` inside one Durable Object, store application records in existing D1 tables, and connect browsers with HTTP and server-sent events. The Worker forwards sync traffic to the same object so its mutation queue and connected clients share one owner.

The [runnable example](https://github.com/tanishqkancharla/tandem/tree/main/examples/cloudflare/apps/server) includes the Worker, browser remote, SQL schema, and Wrangler configuration. It uses no web framework, WebSockets, or R2 adapter. Copy its handlers into an existing Worker or a fetch-style framework such as Hono.

The SQL adapter is experimental: mutation acknowledgements remain in memory. D1 preserves records after an object restart, but pending writes can replay or encounter mutation gaps. This guide demonstrates hosting and SSE recovery; durable mutation recovery is separate work. See [D1 storage](storage/d1.md) before using it for production writes.

## 1. Configure bindings

Install the server and client libraries in your application, with Wrangler as a development dependency:

```sh
pnpm add @tanishqkancharla/tandem-core @tanishqkancharla/tandem-server errore
pnpm add -D wrangler @cloudflare/workers-types
```

These APIs require a Tandem release containing the SQL adapter. To try the checkout before publication, run `pnpm install` and `pnpm exec turbo run build --filter=@tanishqkancharla/tandem-server` from the repository root, then work in `examples/cloudflare/apps/server`.

Use your existing D1 binding or create a database with `pnpm exec wrangler d1 create tandem-example`. Set its ID in `wrangler.jsonc`:

```jsonc
{
  "name": "tandem-cloudflare-example",
  "main": "src/index.ts",
  "compatibility_date": "2026-07-01",
  "compatibility_flags": ["nodejs_compat"],
  "d1_databases": [{
    "binding": "DB",
    "database_name": "tandem-example",
    "database_id": "YOUR_DATABASE_ID"
  }],
  "durable_objects": {
    "bindings": [{ "name": "SYNC", "class_name": "SyncObject" }]
  },
  "migrations": [{ "tag": "v1", "new_sqlite_classes": ["SyncObject"] }]
}
```

The Durable Object class declaration selects Cloudflare's SQLite-backed object type. The example does not use that object's storage for application records; those live in D1. `nodejs_compat` supports dependencies imported by the server package.

When adding this to an existing Worker, merge the bindings and add a new migration tag rather than replacing its configuration. An existing Durable Object can own the `TandemServer` directly instead of adding another object class.

## 2. Reuse your Tandem schema

Use collection and field names that match the database's table and column names. Define field types with the same schema builder used by clients:

```ts
import { collection, defineSchema, t } from "@tanishqkancharla/tandem-core"

export const schema = defineSchema({
  tasks: collection({ id: t.id(), text: t.string(), done: t.boolean() }),
})
```

The example uses `tasks(id, text, done)`, with `id` as the primary key and `done` stored as `0` or `1`. Give the adapter your schema and D1 binding:

```ts
import { TandemServerD1Storage } from "@tanishqkancharla/tandem-server/sql"
import { schema } from "./schema"

const storage = new TandemServerD1Storage({ schema, database: env.DB })
```

The adapter derives column mappings, converts booleans, binds read parameters, and commits each write batch atomically through D1's `batch()`. It creates no tables or columns and does not persist tuple keys. For custom names, compound IDs, or custom value types, see the lower-level [SQL mapping API](storage/custom.md#custom-sql-mappings).

For the standalone example, create its table locally:

```sh
pnpm exec wrangler d1 execute tandem-example --local --file schema.sql
```

Existing applications should use their own schema setup and migrations.

## 3. Host the server and SSE route

Construct the server once in the Durable Object constructor, using the shared application schema:

```ts
this.server = new TandemServer({ schema, relations: {}, storage })
```

The example's [Worker source](https://github.com/tanishqkancharla/tandem/blob/main/examples/cloudflare/apps/server/src/index.ts) validates the request envelope and decodes push mutations with `MutationApi.codec(schema)`. Its routes are:

| Route | Handler |
| --- | --- |
| `POST /api/tandem`, action `push` | `server.push(args)` |
| `POST /api/tandem`, action `pull` | `server.pull(args)` |
| `GET /api/tandem/events?clientId=…` | `createTandemEventStreamResponse(...)` |

The SSE handler returns a standard `Response`:

```ts
const clientId = url.searchParams.get("clientId")
if (!clientId) return new Response("Missing clientId", { status: 400 })
return createTandemEventStreamResponse({
  remote: this.server,
  clientId: tag<ClientId>(clientId),
  schema,
  signal: request.signal,
})
```

Forward both requests and streams to the same named object:

```ts
return env.SYNC.getByName("app").fetch(request)
```

In an existing Worker, route only the sync paths here and keep your other handlers. Use your application's authentication and authorization for pushes, pulls, and the SSE route; live events can contain records. The standalone example has no authentication. Backend jobs should also write through this object's Tandem server, rather than updating synced tables independently.

## 4. Connect clients

Use the example's [browser remote](https://github.com/tanishqkancharla/tandem/blob/main/examples/cloudflare/apps/server/src/remote.ts), or adapt the [Quickstart HTTP transport](quickstart.md#5-add-a-server). It forwards pushes and pulls and uses `connectTandemEventSource` for notifications.

Serve or proxy the sync routes under the application's origin. For a local frontend on another port, configure its dev-server proxy to forward both `/api/tandem` and `/api/tandem/events` to the Worker on port 8787.

```ts
import { TandemClient } from "@tanishqkancharla/tandem-core"
import { schema } from "./schema"
import { createRemote } from "./remote"

const db = new TandemClient({
  schema,
  remote: createRemote(window.location.origin),
})

db.subscribe({ collection: "tasks" }, (tasks) => console.log(tasks))

const tx = db.transact()
tx.set("tasks", { id: crypto.randomUUID(), text: "Try D1 sync", done: false })
await db.commit(tx)
```

A client must subscribe to a query before another client's matching writes appear. The browser remote triggers a pull after a successful push so the writer can confirm it while SSE is unavailable. The SSE helper pulls after every connection's `ready` event, retries closed streams, and performs fallback pulls. It does not replay missed SSE messages; the pull reads the current subscribed records.

## 5. Run and deploy

From the example directory:

```sh
pnpm dev
```

Run its transport test with `pnpm test`. The test bundles the actual Worker and uses local D1, a Durable Object, two clients, and real SSE connections. It checks an existing SQL row, a write visible to another client, catch-up after reconnecting, and writer acknowledgement while the SSE route returns 503.

For a new example database, apply the schema remotely before deploying. Skip the schema command when using existing application tables:

```sh
pnpm exec wrangler d1 execute tandem-example --remote --file schema.sql
pnpm run deploy
```

SSE streams keep the object active rather than using WebSocket hibernation. Deployments and runtime restarts can close connections; browsers reconnect and pull their views again. Keep restart-safe mutation handling separate from that connection recovery.

This setup deliberately uses one database and one object. SQL query pushdown, durable sync metadata, and tenant partitioning are later changes.

## References

- [Cloudflare D1 batches](https://developers.cloudflare.com/d1/worker-api/d1-database/#batch)
- [Streaming from Durable Objects](https://developers.cloudflare.com/durable-objects/examples/readable-stream/)
- [Durable Object lifecycle](https://developers.cloudflare.com/durable-objects/concepts/durable-object-lifecycle/)
