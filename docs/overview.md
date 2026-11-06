# Overview

Tandem is a sync engine and database for collaborative apps. Each client keeps a local database that the UI reads from directly. Writes apply locally right away, and Tandem syncs them with a server in the background.

## Why

Collaborative apps need a few things at once:

- Writes that show up in the UI immediately
- Changes from other clients that appear without a reload
- A consistent result when clients edit the same data at the same time
- Something sensible to do when the network is slow or unavailable

Tandem handles these in the data layer, so app code can read and write local data without managing requests.

## Components

```mermaid
graph LR
	App --> TandemClient
	TandemClient --> LocalDB[Local database]
	TandemClient --> SyncEngine[Sync engine]
	LocalDB --> ClientStorage[IndexedDB, optional]
	SyncEngine -->|HTTP or RPC| Server[TandemServer]
```

### `TandemClient`

`TandemClient` is the app-facing API from `@tanishqkancharla/tandem-core`. It exposes:

- `query` and `subscribe` for typed object queries
- `transact` and `commit` for writes
- `connect`, `disconnect`, and `pullFromRemote` for sync control

### Local database

The local database stores records as ordered tuples. It evaluates queries in memory and can persist to IndexedDB through `TandemClientIndexedDbStorage`.

### Sync engine

The sync engine runs when a client has a `remote`. It pushes local mutations, pulls patches for the queries the client subscribes to, and rebases pending local mutations on top of each patch. See [How sync works](sync.md).

### Server connection

`TandemServer` from `@tanishqkancharla/tandem-server` receives pushed mutations, returns records for subscribed queries, and notifies clients of changes. In a browser app, a small HTTP or RPC transport forwards calls to it. See [Server](server.md#connect-clients).

## Current limitations

- Conflicts resolve as last write wins per record. There are no field-level merges or intents.
- Cookies, revisions, and client views reset when the server process restarts. Mutation acknowledgement durability depends on the [storage adapter](server.md#limitations).
- [Permissions](permissions.md) belong to the application. Named mutation hooks support write authorization; read and connection access need server-side enforcement in your transport or remote.
- There is no built-in application schema versioning or client migration runner. Your application owns [migrations](migrations.md), including pending offline writes.


## Next steps

- [Quickstart](quickstart.md): build a synced app
- [How sync works](sync.md): understand push, pull, and rebase
- [Choosing storage](sql.md): select a server storage adapter
- [Client](client.md): configure queries, persistence, and lifecycle
