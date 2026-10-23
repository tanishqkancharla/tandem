# Custom remotes

A remote is any object that implements `RemoteApi`. [`TandemServer`](server.md) is the reference implementation. Most apps should use it behind a thin transport. Write your own remote only when the source of truth must live somewhere else, such as an existing database.

## Contract

```ts
type RemoteApi<Schema> = {
	connect(api: {
		clientId: ClientId
		poke: () => Promise<void>
	}): Promise<() => Promise<void>>

	push(args: {
		clientId: ClientId
		mutations: Mutation<Schema>[]
	}): Promise<void>

	pull(args: {
		clientId: ClientId
		cookie?: Cookie
		scanWindow: ScanWindow<Schema>
	}): Promise<{
		cookie: Cookie
		patch: {
			set?: { collection: string; value: Record }[]
			remove?: { collection: string; id: Id }[]
		}
		lastMutationId: MutationId
	}>
}
```

All of these types are exported from `@tanishqkancharla/tandem-core`. [How sync works](sync.md) explains how the client uses each call.

## `connect`

Store `poke` for the client and call it whenever that client may have new data. Return a function that stops poking. The client calls `connect` on construction unless `autoConnect` is `false`, and it only pushes and pulls while connected.

Any signal works: a WebSocket message, an SSE event, or a polling timer.

## `push`

Apply the mutations in order. Each `set` carries a full record, and each `remove` carries an ID. Mutation IDs are per-client counters, so they arrive in increasing order. After they are applied, remember the last mutation ID for `clientId` so `pull` can report it.

Reject if the mutations cannot be applied. The client then rolls back the whole batch locally, and each affected `commit` promise rejects. Authorization and validation belong here too: reject a push the client may not make.

## Mutation codecs at the wire boundary

`RemoteApi` carries runtime values. Use `MutationApi.codec(schema)` when a transport serializes push mutations: encode before sending JSON and decode after parsing it, before calling `server.push`. It applies each collection's codec to set values, update payloads, and record identities without changing operation order or mutation IDs.

```tsx
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

Collection codecs are optional; collections without them pass their values through and require JSON-native values or transport-owned validation. This codec handles push mutations only, not pull response records, authentication, or authorization. The [todo HTTP transport](../examples/todo/apps/server/src/app.ts) shows the complete request path.

## `pull`

Return a patch that moves the client from the state at `cookie` to the current state, limited to the records `scanWindow` covers.

- `patch.set` holds records in the scan window that are new or changed. Returning every record in the window is also correct, just larger.
- `patch.remove` holds records the client received earlier that were since deleted or dropped out of the window. The client keeps any record that is not explicitly removed.
- `cookie` is opaque to the client. It sends back the last cookie it received. A revision number works.
- `lastMutationId` is the last mutation from `clientId` that the remote applied, or `0` before it applies one. Report it on every pull, even when the patch is empty. The client treats that mutation and all earlier ones as confirmed and stops replaying them.

The scan window is a list of `EncodedQuery` objects. Filters are `[field, operator, value]` tuples, and operators are `=`, `>`, `<`, `>=`, and `<=`. Relation includes appear under `with`. Include related records in `patch.set` so the client can resolve relational queries.

## Wrapping `TandemServer`

To add authentication, validation, or a different transport while keeping Tandem's sync logic, delegate to a `TandemServer`:

```ts
import type { RemoteApi } from "@tanishqkancharla/tandem-core"

function authorizedRemote(
	server: TandemServer<TodoSchema, {}>,
	session: Session,
): RemoteApi<TodoSchema> {
	return {
		connect: (api) => server.connect(api),
		async push(args) {
			for (const mutation of args.mutations) {
				for (const op of mutation.ops) {
					if (!canWrite(session, op)) throw new Error("Forbidden")
				}
			}
			await server.push(args)
		},
		pull: (args) => server.pull(args),
	}
}
```

## Testing

The Tandem test suites exercise remotes through real clients. [`packages/server/test`](../packages/server/test) and [`packages/core/test/sync`](../packages/core/test/sync) show how to wire two clients to one remote. [Gatekeeper](../packages/gatekeeper/README.md) can reorder calls and inject faults between them.
