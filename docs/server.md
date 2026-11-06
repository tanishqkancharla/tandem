# Server

`TandemServer` from `@tanishqkancharla/tandem-server` is a server-side Tandem database. Clients sync against it through your application transport. Server code can also query and mutate records directly.

## Create a server

`TandemServer` takes the same runtime schema and relations as the client, plus a storage adapter. `relations` is required on the server; pass `{}` when you define none.

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

Register shared mutators once in the constructor with `mutators`; optional `hooks` add server-only authorization and post-commit work. `server.mutate.name(args)` retains each registered mutation's argument type. Pass authenticated request context to `server.push(request, { context })`; the server calls the hooks factory with it for each named call in that push. See [Mutations](mutations.md) for definitions, hooks, and completion behavior.

See [Permissions](permissions.md) before exposing sync to users. Mutation hooks authorize named writes; your application must also enforce read access and authorize live connections.

## Connect clients

`TandemServer` exposes `connect`, `push`, and `pull` for client sync. Clients in the same process can use the server as their `remote` directly:

```ts
const client = new TandemClient({ schema, remote: server })
```

Across a network, the client's `remote` is a transport that forwards `push` and `pull` to the server and calls `poke` when there may be new data. The [Quickstart](quickstart.md#5-add-a-server) shows a minimal HTTP transport, and [Add Tandem to an existing API server](existing-api-server.md) shows how to mount those routes in your backend.

After every commit that writes data, the server pokes each connected client whose queries read a collection the commit changed, including collections reached through relation includes. It runs no query to decide: the pull the poke starts compares the client's view with storage. A client's queries are those of its latest pull made while connected, so a client that has not pulled yet gets a bare poke for every commit. Pokes for other records of the same collection are expected; the pull then sends nothing new.

Streaming text takes a shorter path. When a commit only appends to string fields, and the field codec can carry the appended text alone, the server sends a payload with that text instead of a bare poke to each viewer for which all of these hold:

- The viewer has the record, at the value the commit extended.
- No query on the record's collection filters, orders, or joins on an appended field.
- Since the viewer's latest pull, no other commit changed a collection that decides which of those records its queries select: the same collection under a `limit` or `offset`, or a collection an include hangs from.

Anything else gets a bare poke, so text never reaches a viewer whose view may have moved. A record that enters the view without changing, such as the next record under a `limit`, arrives with the pull.

A client's first payload goes out at once. Appends from further commits within `livePokeInterval` (50 ms by default) merge into one payload sent when the interval ends, and consecutive appends to a field join into one. A reply streamed token by token therefore costs each viewer at most one payload per interval. Pass `livePokeInterval: 0` to send each commit's payload on its own. The client whose push made the commit always gets a bare poke at once, so it pulls the acknowledgement instead of waiting for a stream to go quiet, and every bare poke goes out right after any payload still waiting for the interval.

Every pull reports the revision its read reflects. Revisions count this instance's commits and start over in a new instance, like cookies.

Each pull reads the whole window from storage, but the patch carries only what the client lacks. The server remembers, per client, the records its latest pull put in the view and a SHA-256 fingerprint of each one's contents. A pull that returns that pull's cookie gets the records that are new to the view or whose contents changed, and removals for records no query still covers; a pull with nothing new returns an empty patch with its acknowledgement. A pull without a recognized cookie, such as the first one, a retry after a lost response, or any pull after a server restart, gets every record with `reset`. The memory cost is one key and one 64-character fingerprint per record per client; the server keeps no record contents. The server frees this memory when a client's last connection closes, so a client that pulls without ever connecting keeps it until the server restarts. Writes made directly in storage show up in the next pull, because it reads and fingerprints every record again. Values without a canonical form, such as class instances other than `Date`, `Map`, `Set`, and `Uint8Array`, are resent on every pull.

`createTandemEventStreamResponse` serves those pokes to browsers as server-sent events, and `connectTandemEventSource` from `@tanishqkancharla/tandem-core` turns them back into `poke` calls. A poke event's data is the payload as JSON, or empty for a bare poke; pass `schema` to both helpers to apply collection codecs. A stream whose reader falls behind drops payloads and sends one bare poke when it catches up. The stream sends `ready` after it registers, so the client pulls once per connection and catches writes it missed while disconnected. It also sends a keep-alive comment every 15 seconds and closes when the request aborts or the body is cancelled. Open streams keep an HTTP server from closing, so combine the request signal with a shutdown signal, as [`examples/todo`](https://github.com/tanishqkancharla/tandem/blob/main/examples/todo/apps/server/src/app.ts) does. The [Quickstart](quickstart.md#5-add-a-server) shows both sides.

## Collection codecs

A collection codec converts records between runtime values, such as `Date`, and JSON-safe values. `partialObject` builds one from field codecs such as `string`, `date`, `literal`, and `oneOf`, or your own from `codec`:

```ts
import {
	collection,
	date,
	defineSchema,
	partialObject,
	string,
} from "@tanishqkancharla/tandem-core"

const schema = defineSchema({
	events: collection({
		codec: partialObject({ id: string, title: string, startsAt: date }),
	}),
})
```

Tandem applies collection codecs in IndexedDB client storage, between tabs, in the transport codecs below, and when deciding whether appended text can travel in a poke. Pull responses carry runtime records, and Tandem has no pull codec yet. Keep synced fields JSON-native, or encode `patch.set` values with the collection codec in your transport and decode them in the client's remote.

## Transport codecs

The sync methods carry runtime values. Use `MutationApi.codec(schema)` when a transport serializes push mutations: encode before sending JSON and decode after parsing it, before calling `server.push`. It applies each collection's codec to set values, update payloads, and record identities without changing operation order or mutation IDs.

```ts
import { MutationApi } from "@tanishqkancharla/tandem-core"

const mutationCodec = MutationApi.codec(schema)
const body = JSON.stringify({
	clientId,
	mutations: mutations.map((mutation) => mutationCodec.encode(mutation)),
})

// Server HTTP handler, after checking the request envelope:
const decoded = request.mutations.map((mutation) =>
	mutationCodec.decode(mutation),
)
await server.push({ clientId: request.clientId, mutations: decoded })
```

Decode the request's mutations before applying any of them. Return `invalid-request` if decoding fails; do not acknowledge or apply a prefix of an undecodable request. `TandemServer` does not repeat collection encoding or decoding when applying runtime operations.

Collection codecs are optional; collections without them pass their values through and require JSON-native values or transport-owned validation. This codec handles push mutations only, not pull response records, authentication, or authorization. `PokeApi.codec(schema)` does the same for poke payloads; the SSE helpers apply it when given `schema`. The [todo HTTP transport](https://github.com/tanishqkancharla/tandem/blob/main/examples/todo/apps/server/src/app.ts) shows the complete request path.

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

Server transactions have async reads. `set` and `remove` are sync; `update` is async because it reads the current record. Commit them through the server so connected clients get poked. `server.commit` rejects if another commit changed a record the transaction read; start a new transaction to retry.

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

A transaction also has `list`, `scan`, `update`, `remove`, `query`, and `cancel`, which returns a promise.

`update` accepts partial assignments and awaits the current record. Reads in the same transaction see those assignments; missing records and empty payloads are no-ops. Supplied nested objects and arrays replace their entire field. Use `set` for complete replacements; updates cannot change identity or delete fields.

```ts
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

A missing record stays missing. A nullable string field can use `(message.note ?? "") + text`. The app's argument schema should reject malformed text. Concurrent named calls each read the latest committed value in the server queue. A raw transaction whose read went stale fails to commit instead, and you must retry it.

The server compares each committed record with its before image. If the only differences are string extensions whose suffixes round trip through the collection codec, a viewer that already has the record receives compact append pokes. Other changes send a bare poke, and the viewer pulls the record. A poke carries each field's previous length and a guarded previous revision; missing or reordered pokes fall back to a pull. The server tracks the last write of its 10,000 most recently written records; older entries use a conservative guard.

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
	// Optional: report external writes. Returns a synchronous unsubscribe.
	subscribe?(onChange: () => void): () => void
}
```

The [JSON file adapter](storage/json-file.md) reads stored tuples and writes the whole file on each commit. It suits development and examples.

Choose [PostgreSQL](storage/postgresql.md), [MySQL](storage/mysql.md), or [D1](storage/d1.md) for existing application tables, or use [custom storage adapters](storage/custom.md). The SQL adapters keep acknowledgements in memory until durable metadata support is added. See [Choosing storage](sql.md) for their shared mapping and limitations.

Tandem does not create or migrate application tables. See [Schema changes and client compatibility](migrations.md) for server schema changes, persisted client caches, and older offline clients.

## Limitations

- Records and acknowledged mutation IDs persist when the storage adapter persists them. The JSON-file adapter stores both; the experimental SQL adapter persists only application records. Revisions, cookies, and client scan windows live in the server process and reset on restart.
- Pokes come from the `TandemServer` instance that committed the write, or from storage `subscribe` notifications. Writes made by other processes or directly to the database do not poke clients unless storage reports them. Event streams connected to another process miss those pokes and rely on the client's fallback pull. Storage notifications are bare pokes, without records. The server ignores notifications that arrive while it commits its own write, so an external write reported in that window pokes no one; clients see it on their next pull.
- Appends assume the server knows which records left a view. The server compares an appended record's stored value with the one the viewer has, so another process's write to that record makes the append a bare poke even without a notification. When storage reports another process's write through `subscribe`, the server treats every collection as changed until each client pulls. A write that storage does not report can still move other records into a limited page, and the server cannot see that the appended record left the page; its text keeps streaming until the client's next pull.
- Revisions are per instance. If a client's pokes and pulls reach different instances, live records shown from one instance's pokes are dropped by the next pull from another.
- The server has no built-in identity or read permission system. Named mutations support `authorize` hooks, but raw operations bypass them. Authenticate and authorize `push`, `pull`, and `connect` in your transport, including the event stream route. Pokes can carry records from the client's latest pulled view; close all affected connections when access ends. See [Permissions](permissions.md).
