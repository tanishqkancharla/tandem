# Client

`TandemClient` from `@tanishqkancharla/tandem-core` owns a local database, queries, subscriptions, and optional background sync. The [Quickstart](quickstart.md) connects it to a server and React UI.

## Create a client

```ts
import { TandemClient } from "@tanishqkancharla/tandem-core"
import { schema } from "./schema"

const client = new TandemClient({
	schema,
	remote,
	autoConnect: false,
})
await client.ready
await client.connect()
```

`remote` is your application's transport to the [server](server.md#connect-clients). Omit it for a local-only database. `ready` resolves after restoring local storage and initializing replica metadata; await it before transactions, named mutations, or reading the restored `clientId`.

| Option                       | Behavior                                                                    |
| ---------------------------- | --------------------------------------------------------------------------- |
| `schema`                     | Runtime collection definitions and codecs.                                  |
| `relations`                  | Relations defined for the schema.                                           |
| `mutators`                   | Shared named mutations called through `client.mutate`.                      |
| `remote`                     | Transport for pushing writes, pulling records, and receiving notifications. |
| `autoConnect`                | Connect automatically; defaults to `true`.                                  |
| `clientStorage`              | Optional persistent replica cache.                                          |
| `clientStorageWriteInterval` | Batch local persistence; defaults to 120 ms.                                |
| `syncInterval`               | Batch sync work; defaults to 150 ms.                                        |
| `livePullDelay`              | Confirm live payloads after 200 ms without a new payload by default.        |
| `livePullMaxDelay`           | Confirm live payloads within 1 s by default, even during a stream.          |
| `tabs`                       | Shared browser replica settings, or `false` to disable sharing.             |
| `logger`, `rng`              | Optional logging and random ID dependencies.                                |

The four interval options take milliseconds or a `TimerApi`, such as a test timer.

## Read and write

`client.query(query)` returns local records synchronously. `client.subscribe(query, callback?)` returns `{ result, destroy }` and updates the callback when the result changes. Destroy the subscription when no longer needed. See [Queries](queries.md) for filters, sorting, projections, and relations.

Subscriptions also define which records sync downloads. A plain `query` does not add a sync subscription. `pullFromRemote()` refreshes the current subscriptions; it does not fetch every collection.

Use `client.transact()` and `client.commit(tx)` for raw transactions, or register shared operations and call `client.mutate.name(args)`. See [Mutations](mutations.md) for both paths and their failure behavior.

## Persistence

By default, the local database lives in memory. To retain records and pending writes across restarts, supply IndexedDB storage:

```ts
import { TandemClientIndexedDbStorage } from "@tanishqkancharla/tandem-core"
import { schema, type AppSchema } from "./schema"

const client = new TandemClient({
	schema,
	remote,
	clientStorage: new TandemClientIndexedDbStorage<AppSchema>({
		dbName: `tasks:${userId}:${workspaceId}`,
		schema,
	}),
})
await client.ready
```

`flushClientStorage()` writes pending local persistence immediately; it does not wait for server acknowledgement. Scope the database name to the authenticated user and data scope. Updating code does not migrate cached records or pending writes; see [Schema changes and client compatibility](migrations.md).

In browsers, clients with named storage and a remote share a replica across tabs by default. One leader owns storage and remote sync. `tabs.name` defaults to the storage name; an explicit name must use the same user and data scope. `tabs: false` disables this coordination and requires exclusive ownership of that storage. See [Multiple tabs](sync.md#multiple-tabs) for the process.

## Lifecycle

| Method                 | Behavior                                                                                                            |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `connect()`            | Start sync and wait for the first pull and any pending push. Resolves to a disconnect function. Requires a remote.  |
| `disconnect()`         | Stop this client's remote participation without discarding records or pending writes.                               |
| `pullFromRemote()`     | Pull the current subscriptions and wait for the result. Rejects on a remote error; does nothing while disconnected. |
| `flushClientStorage()` | Save local persistence immediately.                                                                                 |
| `clear()`              | Discard local records and pending mutations; synced clients start a new sync identity. Does not undo server writes. |
| `close()`              | Stop this client; a shared-tab leader saves the replica and hands leadership to another tab.                        |

If that first pull or push fails, `connect()` rejects, but the client stays connected. `clear()` preserves connection state and can reconnect. Stop writes and disconnect first when resetting an application session, and await the reset before new work. With shared tabs, `connect()` and `disconnect()` affect this tab's wish to sync; the leader remains connected while another tab still wants it. There `connect()` resolves once the leader is connected, and the first pull and push run in the background.
