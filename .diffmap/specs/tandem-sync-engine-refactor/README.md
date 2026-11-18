# Split Tandem into a client, a stateless backend, and an optional sync engine

A plan for running Tandem's server without state, so it fits serverless hosts, and moving the job of telling clients about changes into a separate, optional sync engine. Nothing here is built yet.

## Problem

`TandemServer` does three jobs in one object, and two of them need a long-lived process:

1. It runs mutations and writes the database. This needs no state between requests.
2. It answers pulls with a diff against what each client last saw. It keeps that view in memory, per client.
3. It holds every client's event stream and pokes clients after each commit. It keeps the connections, what each client reads, and a per-instance commit counter in memory.

So every request and event stream for one data scope must reach the same process. The docs say so: "Route that scope to one owner" ([[docs/existing-api-server.md]]). That works on a Node server or a Durable Object, but not on Vercel, Netlify, or Lambda, where each request may reach a fresh instance and long connections are costly. It also means only writes made through that process reach clients live: a background job that writes the database directly pokes no one.

## Solution overview

Split the three jobs into three pieces with narrow contracts:

```mermaid [Three pieces]
flowchart LR
    C[Client: TandemClient] -->|push, pull over HTTP| S[TandemBackend, stateless]
    S -->|reads and writes records and metadata| DB[(App database)]
    S -->|publish: these channels changed| E[Sync engine, optional]
    DB -.->|change feed, optional| E
    E -->|poke over SSE, WebSocket, Ably, or Pusher| C
    %% ref node:C [[packages/core/src/TandemClient.ts#TandemClient]]
    %% ref node:S [[packages/server/src/TandemServer.ts#TandemServer]]
```

- **Client.** Unchanged in spirit. It pushes and pulls through the backend, and opens a live connection to whatever sync engine the app uses. The client's `RemoteApi` already separates `connect` from `push` and `pull` ([[packages/core/src/sync/SyncEngine.ts#RemoteApi]]), which is the seam this plan uses.
- **Backend (`TandemBackend`).** Runs mutations and pulls per request, keeping everything it needs between requests in the database: client acknowledgements and, if the app wants small pulls, each client's view. After a commit it publishes the names of the channels that changed.
- **Sync engine (`TandemSyncEngine`).** Holds live connections and pokes the clients subscribed to a channel. A poke carries no data; it only tells the client to pull. The sync engine does not read records or answer pulls. It can run inside the backend's process (today's model), as Tandem's own Node service, as a Durable Object or Rivet actor, or as a hosted service such as Ably or Pusher. A database change feed can feed it too.

`TandemServer` becomes the bundle of a backend and a sync engine in one long-lived process. Serverless apps use `TandemBackend` directly; Node servers, Durable Objects, and Rivet actors use `TandemServer`.

The pages explain the parts in order:

1. [How Tandem syncs today](01-how-tandem-syncs-today.md): push, pull, the event stream, what the database holds, and the integrations.
2. [Target architecture and deployment modes](02-target-architecture.md): push and pull step by step, `TandemServer` as a bundle, and one Durable Object per room.
3. [Library API](03-library-api.md): the interfaces that let one codebase run in every mode.
4. [Database metadata](04-database-metadata.md): the tables the backend and sync engine need, and why Kysely rather than fumadb.
5. [Engineering blockers](05-engineering-blockers.md).
6. [Design questions, explained](06-design-questions-explained.md): a diagram for each open question, beside its alternative.
7. Ten migration phases, one commit-sized step per page:
   1. [Store client acknowledgements in the database](07-durable-client-acks.md)
   2. [Make pokes carry no data](08-remove-live-payloads.md)
   3. [Pull after push](09-pull-after-push.md)
   4. [Split TandemServer into TandemBackend and TandemSyncEngine](10-extract-sync-engine.md)
   5. [Channels in pull responses and publishes](11-channels.md)
   6. [Run TandemBackend without state between requests](12-stateless-pulls.md)
   7. [Run the sync engine as its own service](13-standalone-sync-engine.md)
   8. [Ably and Pusher as sync engines](14-hosted-pub-sub.md)
   9. [Feed the sync engine from Postgres](15-postgres-change-feed.md)
   10. [Adapters for Durable Objects, Next.js, and Rivet](16-first-class-adapters.md)

Phases 1 to 3 stand on their own in today's single-process deployments: they fix duplicate mutations after a restart, delete the live payload code, and stop pending mutations from waiting for a poke. Phases 4 to 6 are the split itself. Phases 7 to 10 add modes and hosts, in any order.

## Design questions to confirm

Each answer below is my recommendation, not a decision, and each one changes the plan. [Design questions, explained](06-design-questions-explained.md) draws each one beside its alternative.

| # | Question | Recommendation | Main alternative | Page |
| --- | --- | --- | --- | --- |
| 1 | How does a commit pick which clients to poke? | Keys that Tandem derives from scan window filters and marked record fields, kept out of the public API. App-written channel functions can come later as an override. | Collection keys only, so multi-tenant apps pull more often; or app-written channel functions from the start, as [Phase 5](11-channels.md) describes now. | [Explained](06-design-questions-explained.md#1-how-does-a-commit-pick-which-clients-to-poke) |
| 2 | Who serves pulls? | The backend. Pulls record nothing about subscriptions in the database; the client joins the pull's channels on the sync engine. | The sync engine serves pulls, which needs the schema, permissions, and storage there, and rules out Ably and Pusher. | [Target architecture](02-target-architecture.md#why-the-backend-serves-pulls) |
| 3 | How does the sync engine learn about commits? | The backend publishes each commit's channels; a Postgres change feed is an optional second source. | Change feed only, which catches writes made outside Tandem but needs Postgres. | [Library API](03-library-api.md) |
| 4 | Is a lost publish acceptable? | Yes. A crash between commit and publish delays clients until their fallback pull (60 seconds by default). | A transactional outbox table, which adds a writer and a reader. | [Blockers](05-engineering-blockers.md#6-publishing-is-not-atomic-with-the-commit) |
| 5 | How do concurrent backend instances keep mutators serial? | Lock the scope's row in `tandem_scopes` inside a database transaction; use a single writer (Durable Object, Rivet actor, one process) where the database has no interactive transactions. | Optimistic commit with retry, which also works on D1 but adds a version column and reruns mutators. | [Blockers](05-engineering-blockers.md#1-mutators-stop-being-serial) |
| 6 | How do stateless pulls stay small? | Start with resets; an optional view table in the database keeps pulls incremental for apps that want it. | Require the view table from the start. | [Phase 6](12-stateless-pulls.md) |
| 7 | How do clients authenticate to the sync engine? | A short-lived HMAC token the backend signs, listing the client and its channels, refreshed on each pull. | The sync engine calls the backend to check each connection. | [Phase 7](13-standalone-sync-engine.md) |
| 8 | What closes the gap between a pull's read and joining its channels? | The client pulls once more whenever a grant adds channels. | The sync engine buffers publishes per channel for a short time and replays them on join. | [Phase 5](11-channels.md) |
| 9 | Is one `TandemClient` per Durable Object room acceptable? | Yes. A page that shows two rooms opens two clients. | One client with several remotes, which needs a mutation sequence per remote. | [Adapters](16-first-class-adapters.md#one-object-per-room) |
| 10 | Which Postgres change feed ships first? | Triggers with `NOTIFY`, which work on every host; logical replication later, for apps that need to resume after downtime. | Logical replication first. | [Phase 9](15-postgres-change-feed.md#two-ways-to-read-changes) |
| 11 | What happens to `TandemServer.subscribe`? | Keep it on `TandemServer` only, documented as seeing only that process's commits. | Feed it from the sync engine or a change feed, so it works with several instances. | [Blockers](05-engineering-blockers.md#5-server-side-reactive-queries) |
| 12 | fumadb or Kysely for the metadata tables? | Kysely, which the SQL adapters already use. | fumadb, which adds zod, commander, and clack at runtime. | [Database metadata](04-database-metadata.md#fumadb-or-kysely) |
| 13 | What are the package and class names? | `tandem-backend` (`TandemBackend`), `tandem-sync` (`TandemSyncEngine`), and `tandem-server` (`TandemServer`, the bundle). The client's `SyncEngine` class becomes `TandemClientSync`. | Keep one server package with subpaths for the sync engine. | [Library API](03-library-api.md#packages) |

Already decided by Tanishq:

- Pokes carry no data. The plan removes poke payloads, live text appends, and revisions ([Phase 2](08-remove-live-payloads.md)).
- The stateless piece is `TandemBackend` ([Naming](#naming-the-stateless-piece)).
- `TandemServer` is a backend and a sync engine bundled in one process. Serverless apps use `TandemBackend` directly; Node servers, Durable Objects, and Rivet actors use `TandemServer`.

## Naming the stateless piece

"Server" suggests a process that stays up and holds connections. The stateless piece does neither: it runs per request and keeps nothing between requests. Only the sync engine holds connections. Tanishq chose `TandemBackend` from these options:

| Name | For | Against |
| --- | --- | --- |
| `TandemBackend` (chosen) | Says where it runs, the app's backend, not how. Pairs with `TandemClient` and `TandemSyncEngine`. Works as a package name, `@tanishqkancharla/tandem-backend`. | "Backend" is broad; the docs must say it is a library inside the app's backend, not a service. |
| `TandemBackendApi` | Says it is the API the client calls. | In this codebase an `Api` suffix names interface types (`RemoteApi`, `ClientApi`, `TandemServerStorageApi`, `RngApi`), so a class with that name reads as an interface. |
| `TandemHandler`, with `createTandemHandler` | Says it handles one request at a time, which suits serverless. | Undersells it: the object also runs server-owned mutations (`mutate`), queries, and transactions outside any request. |
| `TandemApi` | Short. | Same `Api` suffix clash, and vaguer than the others. |

With `TandemBackend`, the related names follow: `TandemServerTransaction` becomes `TandemBackendTransaction`, `TandemServerStorageApi` becomes `TandemBackendStorageApi`, the HTTP entry point is `handleTandemRequest(backend, request)`, and `TandemServer` names the bundle of a backend and a sync engine in one process. [Phase 4](10-extract-sync-engine.md) makes the split; pages before it describe today's `TandemServer`.

## Goals

- `TandemBackend` handles push and pull on any host that runs a request handler, including serverless functions, with no state kept between requests.
- Apps choose how clients hear about changes: a sync engine in the same process (`TandemServer`), Tandem's sync engine service, a hosted pub/sub service, or a database change feed.
- A deployment that runs everything in one process keeps working with no new moving parts.
- Durable Objects, Next.js, and Rivet each get a small, documented adapter.
- `dst/` can run the stateless backend across several instances, with faults and crashes, through the public API.

## Non-goals

- Pulls through the sync engine, or a sync engine that reads records and computes diffs (the Zero and Electric model). [02](02-target-architecture.md#why-the-backend-serves-pulls) explains why.
- Keeping today's protocol or storage layout compatible. Tandem is unreleased.
- Poke payloads, live text appends, and revisions. Pokes carry no data; [Phase 2](08-remove-live-payloads.md) removes them and explains what streamed text loses.
- A hosted Tandem service.
- Non-SQL databases for metadata.

## Prerequisites

[PR #112](https://github.com/tanishqkancharla/tandem/pull/112), which makes tandem-core's main entry isomorphic, is still open. This plan assumes it lands first: a sync engine and live transports must run in Node, Workers, and Rivet without browser globals, and the platform module it adds is where a WebSocket or fetch-based event source would read its runtime values.

## References

- [[packages/server/src/TandemServer.ts]]
- [[packages/server/src/TandemEventStream.ts]]
- [[packages/server/src/storage/TandemServerStorage.ts]]
- [[packages/server/src/storage/TandemServerSqlStorage.ts]]
- [[packages/core/src/sync/SyncEngine.ts]]
- [[packages/core/src/sync/TandemEventSource.ts]]
- [[examples/cloudflare/apps/server/src/index.ts]]
- [[docs/server.md]], [[docs/existing-api-server.md]], [[TODO.md]]
- [PR #112: Make tandem-core's main entry isomorphic](https://github.com/tanishqkancharla/tandem/pull/112)
- [fumadb](https://github.com/fuma-nama/fumadb), [Kysely migrations](https://kysely.dev/docs/migrations)
- [Vercel: publish and subscribe for realtime](https://vercel.com/guides/publish-and-subscribe-to-realtime-data-on-vercel), [Ably](https://ably.com/docs), [Pusher Channels](https://pusher.com/docs/channels/)
- [Rivet actors](https://rivet.dev/docs/actors), [Cloudflare Durable Objects](https://developers.cloudflare.com/durable-objects/)
