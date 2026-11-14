# Add Tandem to this project

You are adding [Tandem](https://tandemsync.dev) sync to an existing app. Tandem gives each client a local database that applies writes instantly and syncs them through the app's existing backend. Do not create a new service or deployment: `TandemServer` is a library that runs inside the server this project already has.

Full documentation: https://docs.tandemsync.dev. The [Quickstart](https://docs.tandemsync.dev/quickstart) has complete code for every step below.

## 1. Look before you change anything

Find and note:

- The package manager (lockfile) and whether this is a monorepo.
- The client framework. Tandem has React bindings; other frameworks use the core client directly.
- The backend and HTTP framework, and where its routes are registered.
- The data that should sync between clients. Start with one collection.

If the project has no backend, stop and ask the user where the server code should run.

## 2. Install

```sh
pnpm add @tanishqkancharla/tandem-core @tanishqkancharla/tandem-react # client
pnpm add @tanishqkancharla/tandem-server # backend
```

Use the project's package manager. Skip `tandem-react` if the client does not use React.

## 3. Define a shared schema

Put the schema where both client and server can import it.

```ts
import { collection, defineSchema, t } from "@tanishqkancharla/tandem-core"

export const schema = defineSchema({
	todos: collection({
		id: t.id(),
		text: t.string(),
		complete: t.boolean(),
	}),
})
```

Field builders are `t.id()`, `t.string()`, `t.number()`, and `t.boolean()`. Model the collection on the project's existing types.

## 4. Mount the server in the existing backend

Create one `TandemServer` and add two routes next to the existing ones:

- `POST /api/tandem` with body `{ action: "push" | "pull", args }`. Respond with `await server.push(args)` or `await server.pull(args)`.
- `GET /api/tandem/events?clientId=...`. Return `createTandemEventStreamResponse({ remote: server, clientId, schema, signal })`.

`TandemServerJsonFileStorage` is fine for development. It is not meant for production. If the project uses PostgreSQL, MySQL, or Cloudflare D1, tell the user about the experimental SQL adapters in [Choosing storage](https://docs.tandemsync.dev/sql), including their limits; otherwise point them to [Custom storage adapters](https://docs.tandemsync.dev/storage/custom). [Add Tandem to an existing API server](https://docs.tandemsync.dev/existing-api-server) shows the routes in a real backend.

Run a single `TandemServer` instance. Apply the project's existing authentication to both routes, and limit each user's pulls and event stream to data they may read; see [Authentication and permissions](https://docs.tandemsync.dev/permissions). If you cannot enforce read access, tell the user.

## 5. Create the client

Create one `TandemClient` with the schema, `TandemClientIndexedDbStorage` for persistence, and a `remote` that forwards `push` and `pull` to `/api/tandem` and uses `connectTandemEventSource` for `/api/tandem/events`. With React, set `autoConnect: false` and wrap the app in `<TandemClientProvider client={db} connect>`.

## 6. Replace one data path

Pick one screen. Read with `useTandemQuery` (or `client.subscribe`) and write with `useTandemTransaction` (or `client.transact` and `client.commit`). Leave the rest of the app as it is.

## 7. Verify

- Run the project's type check, lint, and tests.
- Start the app and open it in two separate browser profiles, or a normal and a private window. Write in one and confirm the change appears in the other without a reload. Two tabs of one profile share data locally, so they pass even when the server is not syncing.

Report what you changed, which routes you added, and anything you could not wire up.
