# @tanishqkancharla/tandem-cloudflare

A lightweight Tandem sync coordinator on Cloudflare Durable Objects, for serverless apps that already own a database such as D1.

- The app's database stays the source of truth. The coordinator reads and commits through an authenticated bridge endpoint served by the app.
- One Durable Object per app holds WebSocket connections and disposable per-client views. Pushes, pulls, and pokes ride one hibernatable socket per client.
- Each mutation's acknowledgement commits in the same database batch as its writes, so retries after lost responses or coordinator restarts never apply twice.
- App code that writes the database directly calls `notifyTandemCoordinator` after committing, and connected clients pull.

See [docs/cloudflare.md](../../docs/cloudflare.md) for setup, and [`examples/cloudflare-d1`](../../examples/cloudflare-d1) for a deployable app.

## Entry points

| Import | Runs in | Exports |
| --- | --- | --- |
| `@tanishqkancharla/tandem-cloudflare` | Coordinator Worker and app server | `createTandemCoordinator`, `handleTandemBridgeRequest`, `TandemD1Storage`, `tandemD1ClientTableSql`, `createTandemClientToken`, `notifyTandemCoordinator`, `getTandemCoordinatorStats` |
| `@tanishqkancharla/tandem-cloudflare/client` | Browser | `TandemCoordinatorRemote`, `keepTandemClientConnected` |
