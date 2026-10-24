# Server

`TandemServer` from `@tanishqkancharla/tandem-server` is a server-side Tandem database. It implements `RemoteApi`, so clients can sync against it, and it also exposes its own query and transaction API for server code.

## Create a server

`TandemServer` takes the same runtime schema and relations as the client, plus a storage adapter.

```ts
import {
	TandemServer,
	TandemServerJsonFileStorage,
} from "@tanishqkancharla/tandem-server"
import { schema, type TodoSchema } from "./schema"

const server = new TandemServer({
	schema,
	relations: {},
	storage: new TandemServerJsonFileStorage<TodoSchema>({
		filePath: "./data/tandem.json",
	}),
})
```

Call `server.close()` on shutdown to close storage.

## Connect clients

`TandemServer` has `connect`, `push`, and `pull` methods that match `RemoteApi`. Clients in the same process can use the server as their `remote` directly:

```ts
const client = new TandemClient({ schema, remote: server })
```

Across a network, the client's `remote` is a transport that forwards `push` and `pull` to the server and calls `poke` when there may be new data. The [Quickstart](quickstart.md#5-add-a-server) shows a minimal HTTP transport, and [`examples/todo`](../examples/todo) has a complete Hono server.

After every commit that writes data, the server pokes each connected client whose view the commit changed. A client's view is the scan window of its latest pull. The poke carries the commit's revision and the changed records inside that view, so the client shows them before it pulls:

- `set` holds each changed record in the view, in full, even after a partial `update`.
- `remove` holds records the client already has that the commit deleted or moved out of its view.

Pokes never carry a record, or name a record ID, that a pull with the same window would not return. Relation includes, limits, and offsets are evaluated the way a pull evaluates them. A record that enters the view without changing, such as the next record under a `limit`, arrives with the pull that every poke still starts. A client that has not pulled yet gets a bare poke, and the client whose push made the commit always gets one, so it pulls the acknowledgement.

Every pull reports the revision its read reflects. Revisions count this instance's commits and start over in a new instance, like cookies.

`createTandemEventStreamResponse` serves those pokes to browsers as server-sent events, and `connectTandemEventSource` from `@tanishqkancharla/tandem-core` turns them back into `poke` calls. A poke event's data is the payload as JSON, or empty for a bare poke; pass `schema` to both helpers to apply collection codecs. A stream whose reader falls behind drops payloads and sends one bare poke when it catches up. The stream sends `ready` after it registers, so the client pulls once per connection and catches writes it missed while disconnected. It also sends a keep-alive comment every 15 seconds and closes when the request aborts or the body is cancelled. Open streams keep an HTTP server from closing, so combine the request signal with a shutdown signal, as [`examples/todo`](../examples/todo/apps/server/src/app.ts) does. The [Quickstart](quickstart.md#5-add-a-server) shows both sides.

## Read and write on the server

Queries use the same object shape as the client (see [Queries](queries.md)), but return promises.

```ts
const todos = await server.query({
	collection: "todos",
	where: { complete: false },
})

const { result, destroy } = await server.subscribe(
	{ collection: "todos" },
	(todos) => console.log(todos),
	{ onError: (error) => console.error(error) },
)
```

Server transactions have async reads and sync writes. Commit them through the server so connected clients get poked.

```ts
const tx = server.transact()
const existing = await tx.get("todos", "welcome")
if (!existing) {
	tx.set("todos", {
		id: "welcome",
		text: "Build something",
		complete: false,
		createdAt: Date.now(),
	})
}
await server.commit(tx)
```

A transaction also has `list`, `scan`, `update`, `remove`, `query`, and `cancel`.

`update` accepts partial assignments and awaits the current record. Reads in the same transaction see those assignments; missing records and empty payloads are no-ops. Supplied nested objects and arrays replace their entire field. Use `set` for complete replacements; updates cannot change identity or delete fields.

```tsx
const tx = server.transact()
await tx.update("todos", "welcome", { complete: true })
await server.commit(tx)
```

## Compound IDs

A record ID can be a tuple. Tandem stores its parts in order, and `scan` accepts a prefix of them.

```ts
import { collection, defineSchema } from "@tanishqkancharla/tandem-core"

type Entry = {
	id: readonly [sessionId: string, sequence: number]
	body: string
}

const schema = defineSchema({
	entries: collection<Entry>({ fields: ["id", "body"] }),
})

const tx = server.transact()
const sessionEntries = await tx.scan("entries", { prefix: ["session-1"] })
```

Client transactions support the same `scan` call.

## Storage

Storage adapters implement `TandemServerStorageApi`:

```ts
interface TandemServerStorageApi<Schema> {
	scan(args?: ScanStorageArgs): Promise<TandemTuple<Schema>[]>
	commit(writes: WriteOps<TandemTuple<Schema>>): Promise<void>
	close(): Promise<void>
}
```

`TandemServerJsonFileStorage` keeps tuples in memory and writes the whole file on each commit. It suits development and examples, not production.

## Limitations

- Records are durable when storage is durable. Sync metadata (revisions, acknowledged mutation IDs, client scan windows) lives in the server process and resets on restart.
- Pokes come from the `TandemServer` instance that committed the write, or from storage `subscribe` notifications. Writes made by other processes or directly to the database do not poke clients unless storage reports them. Event streams connected to another process miss those pokes and rely on the client's fallback pull. Storage notifications are bare pokes, without records.
- Revisions are per instance. If a client's pokes and pulls reach different instances, live records shown from one instance's pokes are dropped by the next pull from another.
- The server does no authentication or authorization. Check requests in your transport before calling `push` or `pull`, and authorize `connect` (including the event stream route) the same way: pokes carry the records of the client's latest pulled view to whoever holds its connection. A view stays in effect until the client's next successful pull, so when a user loses access, also close that client's connections.
