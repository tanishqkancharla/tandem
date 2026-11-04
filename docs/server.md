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

Register shared mutators once in the constructor with `mutators`; optional `hooks` add server-only authorization and post-commit work. `server.mutate.name(args)` retains each registered mutation's argument type. Pass authenticated request context to `server.push(request, { context })`; the hooks factory receives it for that request. See [Agent chat](agent-chat.md) for the full pattern.

## Connect clients

`TandemServer` has `connect`, `push`, and `pull` methods that match `RemoteApi`. Clients in the same process can use the server as their `remote` directly:

```ts
const client = new TandemClient({ schema, remote: server })
```

Across a network, the client's `remote` is a transport that forwards `push` and `pull` to the server and calls `poke` when there may be new data. The [Quickstart](quickstart.md#5-add-a-server) shows a minimal HTTP transport, and [`examples/todo`](https://github.com/tanishqkancharla/tandem/tree/main/examples/todo) has a complete Hono server.

After every commit that writes data, the server pokes each connected client whose queries read a collection the commit changed, including collections reached through relation includes. It runs no query to decide: the pull the poke starts compares the client's view with storage. A client's queries are those of its latest pull made while connected, so a client that has not pulled yet gets a bare poke for every commit. Pokes for other records of the same collection are expected; the pull then sends nothing new.

Streaming text takes a shorter path. When a commit only appends to string fields, and the field codec can carry the appended text alone, the server sends a payload with that text instead of a bare poke to each viewer for which all of these hold:

- The viewer has the record, at the value the commit extended.
- No query on the record's collection filters, orders, or joins on an appended field.
- Since the viewer's latest pull, no other commit changed a collection that decides which of those records its queries select: the same collection under a `limit` or `offset`, or a collection an include hangs from.

Anything else gets a bare poke, so text never reaches a viewer whose view may have moved. A record that enters the view without changing, such as the next record under a `limit`, arrives with the pull.

A client's first payload goes out at once. Appends from further commits within `livePokeInterval` (50 ms by default) merge into one payload sent when the interval ends, and consecutive appends to a field join into one. A reply streamed token by token therefore costs each viewer at most one payload per interval. Pass `livePokeInterval: 0` to send each commit's payload on its own. The client whose push made the commit always gets a bare poke at once, so it pulls the acknowledgement instead of waiting for a stream to go quiet, and every bare poke goes out right after any payload still waiting for the interval.

Every pull reports the revision its read reflects. Revisions count this instance's commits and start over in a new instance, like cookies.

Each pull reads the whole window from storage, but the patch carries only what the client lacks. The server remembers, per connected client, the records its latest pull put in the view and a SHA-256 fingerprint of each one's contents. A pull that returns that pull's cookie gets the records that are new to the view or whose contents changed, and removals for records no query still covers; a pull with nothing new returns an empty patch with its acknowledgement. A pull without a recognized cookie, such as the first one, a retry after a lost response, or any pull after a server restart, gets every record with `reset`. The memory cost is one key and one 64-character fingerprint per record per client; the server keeps no record contents. Writes made directly in storage show up in the next pull, because it reads and fingerprints every record again. Values without a canonical form, such as class instances other than `Date`, `Map`, `Set`, and `Uint8Array`, are resent on every pull.

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

### Append text

Define a shared named mutator that reads the record and writes its extended value. The client runs it optimistically; the server runs the same code in its serialized mutation queue.

```ts
const appendReply = defineMutator(schema, {
  args: z.object({ id: z.string(), text: z.string() }),
  run: async (tx, { id, text }) => {
    const message = await tx.get("messages", id)
    if (message) tx.set("messages", { ...message, text: message.text + text })
  },
})
```

A missing record stays missing. A nullable string field can use `(message.note ?? "") + text`. The app's argument schema should reject malformed text. Concurrent named calls each read the latest committed value in the server queue. Raw transactions whose reads ran before another commit do not gain that guarantee.

The server compares each committed record with its before image. If the only differences are string extensions whose suffixes round trip through the collection codec, a viewer that already has the record receives compact append pokes. Other changes send a full record. A poke carries each field's previous length and a guarded previous revision; missing or reordered pokes fall back to a pull. The server tracks the last write of its 10,000 most recently written records; older entries use a conservative guard.

Pending client mutations replay their recorded set operations during rebase, so an optimistic append may temporarily cover newer live text until its confirming pull. The server's named mutation result is authoritative.

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

`TandemTuple<Schema>` covers every tuple Tandem stores, so an adapter stores keys and values as given and returns them from `scan` in tuple-database key order:

- `["record", collection, ...id]` holds each record.
- `["client", clientId]` holds the last mutation applied for each client.
- `["index", collection, name, ...values, ...id]`, with a `null` value, is an index entry, written in the same commit as its record when the schema declares indexes. See [Indexes](queries.md#indexes).
- `["indexes"]` records which index definitions the entries were built for.

The adapter still receives only key and range reads, never queries. Narrow reads help an adapter that can read a key range without reading everything; `TandemServerJsonFileStorage` keeps tuples in memory and parses and rewrites the whole file on each commit, so it gains nothing from them. It suits development and examples, not production.

### Writes outside Tandem

Tandem writes index entries with records. A process that writes records to storage directly leaves the entries stale. If storage reports the write through `subscribe`, the server rebuilds every entry before its next read or write. Otherwise call `await server.rebuildIndexes()` after such writes. A server also rebuilds entries on its first operation when the stored definitions differ from the schema's. Schemas without indexes store no entries and need none of this.

## Limitations

- Records are durable when storage is durable. Sync metadata (revisions, acknowledged mutation IDs, client scan windows) lives in the server process and resets on restart.
- Pokes come from the `TandemServer` instance that committed the write, or from storage `subscribe` notifications. Writes made by other processes or directly to the database do not poke clients unless storage reports them. Event streams connected to another process miss those pokes and rely on the client's fallback pull. Storage notifications are bare pokes, without records.
- Appends assume the server knows which records left a view. The server compares an appended record's stored value with the one the viewer has, so another process's write to that record makes the append a bare poke even without a notification. When storage reports another process's write through `subscribe`, the server treats every collection as changed until each client pulls. A write that storage does not report can still move other records into a limited page, and the server cannot see that the appended record left the page; its text keeps streaming until the client's next pull.
- Revisions are per instance. If a client's pokes and pulls reach different instances, live records shown from one instance's pokes are dropped by the next pull from another.
- The server does no authentication or authorization. Check requests in your transport before calling `push` or `pull`, and authorize `connect` (including the event stream route) the same way: pokes carry the records of the client's latest pulled view to whoever holds its connection. A view lasts until the client's next pull or until its last connection closes, so when a user loses access, close that client's connections: pokes then carry no records until a pull your transport authorizes.
