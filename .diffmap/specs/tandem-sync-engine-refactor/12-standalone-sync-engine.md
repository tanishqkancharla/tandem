# Phase 7: Run the sync engine as its own service

[Phase 6](11-stateless-pulls.md) made the backend stateless and [Phase 5](10-channels.md) made channels the only contract with the sync engine. This phase wraps `TandemSyncEngine` in an HTTP service, so a serverless backend can publish to it and clients can connect to it: mode 2 in [Target architecture](02-target-architecture.md#mode-2-serverless-backend-with-an-external-sync-engine).

**Today**

Pokes come only from the process that committed ([[docs/server.md]]). A server on Vercel cannot hold event streams, so its clients rely on the 60-second fallback pull.

**Proposed**

The app deploys one small Node service, `createTandemSyncEngineServer`, on Fly, Railway, or any VM. The serverless backend publishes to it over HTTP with a shared secret. Clients connect to it with the token from their pull. A commit reaches other clients within one network round trip of the publish.

```ts
// sync-engine.ts, deployed once
import { TandemSyncEngine } from "@tanishqkancharla/tandem-sync"
import { createTandemSyncEngineServer } from "@tanishqkancharla/tandem-sync/node"

const engine = new TandemSyncEngine({ verify: verifyTandemToken(process.env.TANDEM_SECRET!) })
createTandemSyncEngineServer({ engine, publishSecret: process.env.TANDEM_SECRET! }).listen(8787)
```

```ts
// the app's server, in a function
const server = new TandemBackend({
	// ...
	publisher: tandemSyncEngineClient({ url: SYNC_URL, secret: TANDEM_SECRET }),
	live: { url: SYNC_URL, secret: TANDEM_SECRET }, // signs grants in pull responses
})
```

## Routes

| Route | Caller | Auth | Does |
| --- | --- | --- | --- |
| `POST /publish` | Server | `Authorization: Bearer <secret>` | `engine.publish(event)` |
| `GET /events?clientId&token` | Client | Grant token | Opens SSE; sends `ready`, then pokes |
| `POST /channels` | Client | Grant token | `connection.setChannels(grant)` |
| `GET /health` | Host | None | Liveness |

## Tokens

A grant token is an HMAC over the client ID, channels, and expiry, signed with the secret the backend and sync engine share. It is short-lived; each pull issues a fresh one when the old one nears expiry.

```ts
type TandemGrantClaims = { clientId: ClientId; channels: string[]; expires: number }

function verifyTandemToken(secret: string) {
	return async (token: string, clientId: ClientId) => {
		const claims = await verifyHmac<TandemGrantClaims>(token, secret)
		if (claims instanceof Error) return claims
		if (claims.clientId !== clientId || claims.expires < Date.now())
			return new TandemGrantError({ reason: "expired or wrong client" })
		return claims.channels
	}
}
```

The secret signs with Web Crypto, so the backend side runs in Workers and functions.

## Scale

One Node process holds tens of thousands of SSE connections. Past that, several sync engines need publishes fanned out to all of them, through Redis pub/sub or Postgres `NOTIFY`. This phase supports one process and documents the limit; a `TandemPublisher` that writes to Redis can come later without changing clients.

Tests: an end-to-end test runs the backend and sync engine as separate HTTP servers and checks a second client sees a commit without its fallback pull. `dst/` treats publish requests as network messages, so they can be dropped, delayed, or reordered, and asserts that a dropped publish is repaired by the fallback pull within its interval.

```changes

```
