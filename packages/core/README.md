# @tanishqkancharla/tandem-core

The client for [Tandem](https://github.com/tanishqkancharla/tandem), a sync engine and database for collaborative apps. Each client gets a local database that applies writes at once and syncs them with a server in the background.

> [!WARNING]
> Tandem is pre-1.0. APIs change without notice.

```sh
pnpm add @tanishqkancharla/tandem-core
```

```ts
import {
	collection,
	defineSchema,
	t,
	TandemClient,
} from "@tanishqkancharla/tandem-core"

const schema = defineSchema({
	todos: collection({ id: t.id(), text: t.string(), complete: t.boolean() }),
})

const client = new TandemClient({ schema })
await client.ready

const tx = client.transact()
tx.set("todos", { id: "1", text: "Try Tandem", complete: false })
await client.commit(tx)

client.subscribe({ collection: "todos" }, (todos) => console.log(todos))
```

Pass a `remote` to sync with a server built on [`@tanishqkancharla/tandem-server`](https://www.npmjs.com/package/@tanishqkancharla/tandem-server). The package also holds the schema builders, named mutations, and `connectTandemEventSource` for server-sent events.

Two entry points hold code for one runtime, so the main entry runs anywhere:

| Entry                                     | Holds                                                    |
| ----------------------------------------- | -------------------------------------------------------- |
| `@tanishqkancharla/tandem-core/indexeddb` | `TandemClientIndexedDbStorage`, browser IndexedDB storage |
| `@tanishqkancharla/tandem-core/node`      | `JsonlLoggerSink`, a Node file logger                    |

Read the [documentation](https://docs.tandemsync.dev), starting with the [Quickstart](https://docs.tandemsync.dev/quickstart).
