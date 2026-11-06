# Mutations

Tandem applies client writes locally first, then syncs them to the server. Use named mutations for shared operations that the server runs against current records, or raw transactions for direct record operations.

## Named mutations

`defineMutator(schema, definition)` defines one operation. Import it on both client and server and register it under the same name:

```ts
import { defineMutator, TandemClient } from "@tanishqkancharla/tandem-core"
import { TandemServer } from "@tanishqkancharla/tandem-server"
import { z } from "zod"
import { schema } from "./schema"

const completeTask = defineMutator(schema, {
	args: z.object({ id: z.string() }),
	run: async (tx, { id }) => {
		await tx.update("tasks", id, { done: true })
	},
})
const mutators = { completeTask }
const server = new TandemServer({ schema, relations: {}, storage, mutators })
const client = new TandemClient({ schema, mutators, remote: server })
await client.ready
await client.mutate.completeTask({ id: "task-1" })
```

This example runs client and server in one process. Across the network, use the [Quickstart transport](quickstart.md#5-add-a-server). Register server-only authorization before accepting untrusted writes; see [Permissions](permissions.md).

| Definition           | Contract                                                                                                                                        |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `args`               | A Standard Schema validator, such as Zod, or a parser function. Validates on the client and again on the server. Arguments must be JSON values. |
| `run(tx, args, ctx)` | Shared optimistic and server write logic. `ctx.location` is `"client"` or `"server"`.                                                           |

`defineMutators(schema, definitions)` defines a registry of several operations. Names and argument types flow into `client.mutate` and `server.mutate`. Validators such as Zod are application dependencies.

The mutator transaction exposes async `get`, `scan`, and `update`, plus synchronous `set` and `remove`. The client runs the definition optimistically, then sends its name and arguments. The server serializes named calls and runs each definition against its latest committed state. During a rebase, the client replays recorded operations rather than rerunning the definition. Keep external side effects out of `run`.

## Server hooks

`TandemServer({ mutators, hooks })` attaches server-only behavior to shared definitions. The hooks factory receives the context passed by your authenticated transport to `server.push(request, { context })`.

| Hook                       | Behavior                                                                                                                            |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `authorize(tx, args, ctx)` | Runs before the shared definition in the same transaction. Return an `Error` to refuse the entire call; `false` does not refuse it. |
| `afterCommit(args, ctx)`   | Runs after a successful commit. Its failure cannot undo the write; recover durable jobs separately.                                 |

A hook, hooks factory, or `run` that throws also refuses the call. An error caused by a storage failure is not a refusal: the push returns `unavailable`, and the client sends the mutation again.

The server calls the hooks factory once per named call. It sets `ctx.source` to `"client"` for pushes and `"server"` for direct `server.mutate` calls. Direct calls run hooks without a request session. Low-level server transactions do not run mutator hooks. See [Permissions](permissions.md#check-writes-with-named-mutation-hooks) and the [streaming chat guide](agent-chat.md) for examples.

With a mutator registry, even an empty one, pushes refuse raw operation mutations by default. `allowOps: false` keeps that policy explicit. `allowOps: true` applies raw operations with no server check, so your transport must authorize them first.

## Raw transactions

`client.transact()` creates a transaction with synchronous reads and writes. Commit it through the client:

```ts
const tx = client.transact()
tx.set("tasks", { id: "task-1", text: "Try Tandem", done: false })
tx.update("tasks", "task-1", { done: true })
await client.commit(tx)
```

| Method                            | Behavior                                                                                               |
| --------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `get(collection, id)`             | Read one record, including this transaction's writes.                                                  |
| `list(collection)`                | Read the collection.                                                                                   |
| `scan(collection, options?)`      | Read by ID prefix, limit, or reverse order.                                                            |
| `set(collection, record)`         | Replace the complete record at its ID.                                                                 |
| `update(collection, id, payload)` | Assign supplied top-level fields on an existing record. Missing records and empty payloads are no-ops. |
| `remove(collection, id)`          | Remove a record.                                                                                       |
| `cancel()`                        | Discard the uncommitted transaction.                                                                   |

An update cannot change identity or delete fields. Supplied objects and arrays replace the whole field. Do not pass `undefined` to clear a field: the local record changes, but a JSON transport drops the key, so the server keeps its value. Store `null`, or `set` the record without the field. For server transactions, reads, `update`, and `cancel` are async; use `server.commit(tx)`. See [Server](server.md#read-and-write-on-the-server).

## Completion and failures

With a connected remote, client mutation and commit promises settle after the push, not after other clients have received the write. A transport failure rejects the waiting promise but leaves the write pending for a later attempt. While a client with a remote is disconnected, the promise resolves without a push; if the server later refuses the write, no caller sees the error, but the next pull still rolls it back. In a [shared tab](sync.md#multiple-tabs) that does not want the remote, the promise resolves once the leader has saved the write. Local-only writes do not wait for a remote.

When the server refuses a mutation, it commits no record changes but acknowledges its mutation ID and returns a rejection. The waiting call rejects with `MutationRejectedError`; the next pull removes its optimistic effect and replays later pending writes. Keep the push response's `rejected` entries intact in your transport. The server refuses unknown names, invalid arguments, calls whose hooks or `run` return or throw an error, and raw operations when `allowOps` is off. A direct `server.mutate` call rejects with the error instead.

Persisted pending mutations can outlive the code that created them. Changing names or arguments needs an application [compatibility policy](migrations.md). [How sync works](sync.md) explains acknowledgements, conflicts, and rebase in more detail.
