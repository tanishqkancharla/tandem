# Cloudflare D1 todos with a Tandem coordinator

A serverless todo app whose data lives in D1, synced in real time through a separately deployed Tandem coordinator Worker and Durable Object. See [docs/cloudflare.md](../../docs/cloudflare.md) for the design.

- `apps/app`: the app Worker. It owns the D1 database, serves the bridge (`POST /tandem/bridge`), mints client tokens (`POST /api/token`), exposes plain-SQL REST endpoints that invalidate the coordinator after each write (`/api/todos`), and serves the UI.
- `apps/coordinator`: the coordinator Worker and its `TandemCoordinator` Durable Object class.

The demo guards `/api/*` with a shared `DEMO_ACCESS_KEY`. A real app authenticates users with its own session and passes the user ID as the token subject.

## Run locally

```sh
pnpm install
pnpm build
pnpm --filter @tandem/example-cloudflare-d1-app test:e2e
```

The suite starts both app Workers and the coordinator with `wrangler dev` (local workerd, D1, and Durable Objects), then drives real Tandem clients over WebSockets. Local runs are not evidence of Cloudflare behavior; the hibernation and redeploy tests run only against deployed Workers.

## Deploy

Authenticate Wrangler with one of:

- `pnpm --filter @tandem/example-cloudflare-d1-app exec wrangler login` (OAuth; on a remote machine forward port 8976 first: `ssh -L 8976:localhost:8976 <host>`), or
- `export CLOUDFLARE_API_TOKEN=... CLOUDFLARE_ACCOUNT_ID=...` with a token allowed to edit Workers Scripts and D1. The account needs a workers.dev subdomain.

Then:

```sh
node examples/cloudflare-d1/scripts/deploy.mjs
```

The script creates two D1 databases (`tandem-demo-app`, `tandem-demo-app-second`), applies `apps/app/migrations`, deploys the coordinator (`tandem-demo-coordinator`) and both app Workers, generates the shared secrets, sets `TANDEM_SECRET`, `DEMO_ACCESS_KEY`, and `TANDEM_APPS`, and writes URLs and secrets to `examples/cloudflare-d1/.deploy/state.json` (mode 600, ignored by Git). Re-running reuses the databases and secrets. Set `TANDEM_DEMO_PREFIX` to deploy under other names.

Open `<app url>/#key=<accessKey>` in two browsers to try it.

## Test the deployment

```sh
node examples/cloudflare-d1/scripts/live-test.mjs             # all live tests
node examples/cloudflare-d1/scripts/live-test.mjs --redeploy  # also redeploys the coordinator mid-test
```

The suite checks two-client convergence with rows verified through the app's D1 API, invalidation after REST writes with zero idle client frames, reconnect after missed pokes, cross-app and token isolation, hibernation (an `instanceId` change while sockets stay open), a redeploy restart, and a 20-client idle fleet. Timelines are appended to `apps/app/test-results/evidence-live.jsonl`.

## Troubleshoot

| Symptom | Check |
| --- | --- |
| WebSocket upgrade fails with 401 | The token's app ID matches the URL, the app and coordinator share the secret in `TANDEM_APPS`, and the token has not expired |
| Clients connect but never receive data | `TANDEM_APPS[appId].bridgeUrl` reaches the app's `/tandem/bridge`; `wrangler tail tandem-demo-coordinator` shows bridge errors |
| External writes do not appear | The app calls `notifyTandemCoordinator` after committing; `COORDINATOR_URL` is the coordinator's origin |
| Commits rejected with 409 in app logs | Expected for retried or replayed mutations; the acknowledgement already advanced |

## Tear down

```sh
node examples/cloudflare-d1/scripts/teardown.mjs
```

This deletes the three Workers (including the Durable Object namespace and its stored app IDs) and both D1 databases, then removes `.deploy/`. On the Workers Free plan the demo costs nothing at rest; hibernated objects accrue no duration charges.
