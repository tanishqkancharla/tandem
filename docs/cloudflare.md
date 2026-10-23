# Cloudflare Durable Object coordinator

Serverless apps, such as a Worker with D1, have a database but no long-lived process to hold client connections and send pokes. `@tanishqkancharla/tandem-cloudflare` adds one: a coordinator Worker whose Durable Object hosts a [`TandemServer`](server.md) for each app. The app's database stays the source of truth.

```diagram
 Browser                     Coordinator Worker + DO               App Worker + D1
┌──────────────┐  WebSocket  ┌────────────────────────┐  signed   ┌──────────────────┐
│ TandemClient │◀───────────▶│ TandemServer per app   │──HTTPS───▶│ bridge endpoint  │
│ Coordinator  │ push, pull, │ sockets, views (memory)│ scan,     │ TandemD1Storage  │
│ Remote       │ poke        │                        │ commit    │ todos table      │
└──────┬───────┘             └───────────▲────────────┘           └───┬──────────────┘
       │ token request                   │ signed invalidate          │ plain SQL writes
       └────────────────────────────────────────────────────────────▶│ /api/token, REST
```

The [`examples/cloudflare-d1`](../examples/cloudflare-d1) app is a complete, deployable reference with setup, test, and teardown commands.

## What runs where

| Piece | Runs in | State |
| --- | --- | --- |
| `TandemCoordinatorRemote` | Browser | Local replica and pending writes, as with any remote |
| Coordinator Worker | Cloudflare | None. Verifies tokens and routes `/apps/:appId/*` to `idFromName("app:" + appId)` |
| Coordinator Durable Object | Cloudflare | Hibernatable sockets with server-written attachments; in-memory `TandemServer` views; the object's app ID |
| `handleTandemBridgeRequest` + `TandemD1Storage` | App server | Records in ordinary tables, plus `tandem_clients` acknowledgements |

Requests that remain:

- One WebSocket upgrade per client connection. Push, pull, and poke messages ride that socket, with no extra routing request per message.
- One app request for a client token per connection.
- Coordinator-to-app bridge requests: one `describe` per object start; per pull, one acknowledgement scan plus one scan per collection in the scan window; per pushed mutation, one scan and one commit.
- One signed app-to-coordinator invalidation after each external write.
- Optional client keepalive frames (`tandem:ping`, default every 30 seconds). The runtime answers them with `setWebSocketAutoResponse`, so they do not wake a hibernated object.

There is no polling. An idle client sends nothing except keepalive frames, and the coordinator makes no bridge requests until a client message or invalidation arrives.

## Correctness

- Mutation acknowledgements are durable in the app database. `TandemD1Storage` commits each mutation's records and its `tandem_clients` row in one D1 batch, and the acknowledgement must advance by exactly one. A retry after a lost response, a replayed bridge request, or a racing second coordinator instance fails that check and writes nothing, so a stale retry cannot resurrect a later delete.
- A poke is not an acknowledgement. Clients learn which mutations were applied from `lastMutationId` on their next pull, as with any Tandem remote.
- Coordinator memory is disposable. After hibernation, eviction, or a deploy, the object reconnects surviving sockets for pokes from their attachments, and each client's next pull receives a reset snapshot read from the app database.
- Deploys close sockets. `keepTandemClientConnected` reconnects with backoff, and every reconnect pulls before pushing pending writes. Pulls after reconnecting cover invalidations sent while a client was disconnected.
- Invalidation delivery is best effort. If `notifyTandemCoordinator` fails or a client misses the poke, that client converges on its next pull, commit, or reconnect. Nothing guarantees delivery to an idle, connected client that missed a poke.
- Pending local edits keep Tandem's existing policy: a client's unacknowledged set can recreate a record another client deleted before that set reached the server.

## Security

- Apps are configured only by the coordinator operator, in the `TANDEM_APPS` secret: `{ "<appId>": { "bridgeUrl": "https://...", "secret": "<32+ random characters>" } }`. There is no registration endpoint, and the coordinator fetches only configured bridge URLs, which must use HTTPS unless `TANDEM_ALLOW_INSECURE_BRIDGE` is `"true"` (local development).
- Each app's secret signs three distinct message kinds with HMAC-SHA256: client tokens (`createTandemClientToken`, minted by the app for its signed-in user), bridge requests, and invalidations. Signed server requests carry a timestamp and expire after five minutes.
- Tokens carry the app ID, a subject, and an expiry. The coordinator checks the app ID against the URL, stores the verified identity in the socket attachment, checks expiry on every message, and closes expired sockets with code 4001 so the client reconnects with a fresh token. Client IDs are namespaced by subject.
- Every object stores its app ID durably and refuses requests for another app.
- The coordinator validates message size (1 MiB), mutation and operation counts, known collections, and scan window size. The bridge accepts commits only for configured collections, and the D1 adapter checks column types.
- Every authenticated client of an app can read the synced collections. There is no per-row read authorization. Use separate app IDs for separate tenants.

## Set up an app

1. Create the tables. Records use one column per field; add the acknowledgement table from `tandemD1ClientTableSql()`.

2. Serve the bridge, a token endpoint, and invalidate after direct writes:

```ts
import {
	createTandemClientToken,
	handleTandemBridgeRequest,
	notifyTandemCoordinator,
	TandemD1Storage,
} from "@tanishqkancharla/tandem-cloudflare"

const storage = new TandemD1Storage<TodoSchema>({
	db: env.DB,
	collections: {
		todos: {
			table: "todos",
			columns: { id: "text", title: "text", done: "boolean", createdAt: "integer" },
		},
	},
})

// POST /tandem/bridge
handleTandemBridgeRequest(request, {
	appId: env.APP_ID,
	secret: env.TANDEM_SECRET,
	storage,
	collections: ["todos"],
})

// POST /api/token, after authenticating the user
createTandemClientToken({ appId: env.APP_ID, secret: env.TANDEM_SECRET, subject: user.id })

// After any write that bypasses Tandem commits
await notifyTandemCoordinator({
	coordinatorUrl: env.COORDINATOR_URL,
	appId: env.APP_ID,
	secret: env.TANDEM_SECRET,
})
```

3. Connect clients:

```ts
import {
	keepTandemClientConnected,
	TandemCoordinatorRemote,
} from "@tanishqkancharla/tandem-cloudflare/client"

const remote = new TandemCoordinatorRemote<TodoSchema>({
	url: "wss://<coordinator>/apps/<appId>",
	getToken: async () => (await (await fetch("/api/token", { method: "POST" })).json()).token,
})
const client = new TandemClient({ schema, remote })
keepTandemClientConnected(client, remote)
```

## Deploy a coordinator

```ts
// src/index.ts
import { createTandemCoordinator } from "@tanishqkancharla/tandem-cloudflare"

const coordinator = createTandemCoordinator()
export const TandemCoordinator = coordinator.TandemCoordinator
export default coordinator.worker
```

```jsonc
// wrangler.jsonc
{
	"main": "src/index.ts",
	"compatibility_flags": ["nodejs_compat"],
	"durable_objects": {
		"bindings": [{ "name": "TANDEM_COORDINATOR", "class_name": "TandemCoordinator" }],
	},
	"migrations": [{ "tag": "v1", "new_sqlite_classes": ["TandemCoordinator"] }],
}
```

Set `TANDEM_APPS` with `wrangler secret put TANDEM_APPS`. `nodejs_compat` is required because the server package also exports a Node file-storage adapter.

A separately hosted coordinator cannot bind another account's D1 database, which is why the bridge exists. When the app and coordinator share an account, a same-account deployment can still use the bridge unchanged.

## Diagnostics

`getTandemCoordinatorStats` (signed with the app secret) and `remote.stats(clientId)` return the serving object's random `instanceId`, `constructedAt`, open `sockets`, and counts of `pokes` and `bridgeRequests` since construction. An `instanceId` that changes while a socket stays open shows the object was reconstructed without dropping the connection.

## Limits

- One object per app serializes every push and pull for that app. Each pull reads every synced collection in the client's scan window through the bridge, so large collections make pulls proportionally larger and slower.
- `TandemD1Storage` supports text or integer `id` columns, not compound IDs.
- An invalid mutation is rejected with `invalid-request` and stays in the client's outbox, as with other remotes.
