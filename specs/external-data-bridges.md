## Problem overview

App developers want Notion, Gmail, GitHub, and similar APIs to show up as Tandem collections (`notion_pages`, `gmail_messages`) that the browser client can query, subscribe to, and relate to app tables. Tandem has no documented way to do this. Two tempting designs fight each other: compose remotes (a NestedRemote that proxies foreign APIs) or copy foreign rows into the app store with a second Tandem client.

## Solution overview

Do not compose remotes. Treat an external system as another writer of the same app schema. A server-side Tandem client (the bridge) maps Notion pages into `notion_pages` records and `commit`s them to the existing app remote. Browser clients keep using `query`, `subscribe`, and `transact` against ordinary collections. Joins happen locally after both collections are in the replica. Cross-system writes use an outbox collection, not a distributed transaction.

A NestedRemote looks like Postgres foreign data wrappers, but Tandem is a replica engine. Scan windows, cookies, rebase, and pokes assume one canonical store. A live Notion proxy still has to cache, invent versions, and split transactions. Once it caches, it is a bridge that writes into a store. Build that bridge as a Tandem client so the code stays `tx.set` / `tx.remove`.

```ts
const bridge = new TandemClient({ schema, remote: appRemote })
await bridge.connect()

for (const page of await notion.pages.list()) {
	const tx = bridge.transact()
	tx.set("notion_pages", mapNotionPage(page))
	await bridge.commit(tx)
}
```

## Goals

- An app developer adds `notion_pages` to the schema and queries it like any other collection, including `with` relations to app tables.
- A bridge is a `TandemClient` that shares the app remote, not a new RemoteApi, NestedRemote, or connector framework.
- Browser clients see bridge writes through the existing push/poke/pull path after they `subscribe` to the relevant scan window.
- External systems remain source of truth for their collections: a later bridge poll overwrites stale client writes to those rows.
- App-initiated writes into the external system go through an outbox collection the bridge reads, not through 2PC.

## Non-goals

- No migrations or backfills.
- No NestedRemote, collection-prefixed routing, or composite cookies.
- No official Notion, Gmail, GitHub, or other vendor adapter package.
- No query-time proxying of foreign APIs and no new collection flags such as `writable: false` or `source: "external"`.
- No distributed transactions, write-back protocol, schema merge helper, or `RemoteServer.ingest` API.

## Future work

None yet.

## Important files/docs/websites for implementation

- `packages/core/src/TandemClient.ts` - Public client the bridge reuses (`transact`, `commit`, `subscribe`, `connect`).
- `packages/core/src/sync/SyncEngine.ts` - `RemoteApi` (`push` / `pull` / `connect`) the bridge and browser clients already share.
- `packages/server/src/RemoteServer.ts` - In-process remote that applies mutations, appends the mutation log, and pokes intersecting scan windows.
- `packages/core/src/schema/Schema.ts` - `defineSchema` / `defineRelations` used to declare foreign collections as normal tables.
- `packages/core/test/fixtures.ts` - `makeClient` / `makeRemote` factories for a third bridge client alongside browser clients.
- `packages/core/test/TandemClient.spec.ts` - Existing two-client sync coverage to extend with the bridge flow.
- `docs/how_does_tandem_work.md` - Sync model docs that should point at the bridge pattern.
- `docs/how_to_implement_remote.md` - Remote implementer guide; should not grow a NestedRemote section.
- `README.md` - Lists Notion/Gmail/GitHub integrations as future work; link the pattern here.

## Implementation

### Phase 1: Prove a bridge client can publish external rows into the app replica

Add one story-shaped test that treats a third `TandemClient` as a fake Notion poller. Browser clients keep the existing public API. The test should fail if poke/scan-window routing drops bridge writes, if relations across app and external collections do not resolve, or if a later poll does not overwrite a stale browser write to the foreign collection.

```ts
const remote = makeRemote<BridgeSchema>()
const app = await makeClient({ schema, relations, remote })
const bridge = await makeClient({ schema, relations, remote })
await Promise.all([app.connect(), bridge.connect()])

app.subscribe({
	collection: "tasks",
	with: { notionPage: { select: { id: true, title: true } } },
}, onTasks)

const pollTx = bridge.transact()
pollTx.set("notion_pages", { id: "page-1", title: "Spec" })
await bridge.commit(pollTx)
```

- [ ] Add a focused schema in `packages/core/test/TandemClient.spec.ts` (or a nearby test module) with `tasks` and `notion_pages` plus a many-to-one `tasks.notionPage` relation.
- [ ] Create three roles against one `InMemoryRemote`: a browser app client, a second browser client, and a server-side bridge client with no IndexedDB.
- [ ] Have the bridge `commit` mapped external pages; assert subscribed browser clients receive them without calling a new ingest API.
- [ ] Assert a task that points at a `notion_pages` id returns the related page through `with: { notionPage: ... }` after both rows exist on the replica.
- [ ] Have a browser client write a stale title onto `notion_pages`, then have the bridge poll the original external title, and assert every subscribed client converges to the external title.
- [ ] Have a browser client insert a `notion_commands` outbox row; have the bridge subscribe, apply a fake Notion create, `set` `notion_pages`, and `remove` the command; assert the browser client sees the new page and an empty outbox.
- [ ] Verify `pnpm --filter @tanishqkancharla/tandem-core test` passes, including the new story.

### Phase 2: Document the bridge-client DX

Write the pattern down so app developers copy dumb code instead of inventing NestedRemote. Keep the doc to the working replica model: one schema, one remote, one extra client.

```ts
const tx = db.transact()
tx.set("tasks", { id: taskId, title, notionPageId: pageId })
tx.set("notion_commands", {
	id: commandId,
	type: "create_page",
	pageId,
	title,
})
await db.commit(tx)
```

- [ ] Add `docs/external-data.md` explaining bridge clients, the subscribe/scan-window requirement, Notion-wins overwrite, and the outbox write path.
- [ ] State explicitly that NestedRemote, query-time FDW, and cross-system transactions are not the API.
- [ ] Link the doc from `docs/how_does_tandem_work.md` and from the integrations bullets in `README.md`.
- [ ] Verify the doc examples use `TandemClient` + `transact`/`commit`/`subscribe` only; no new types.
