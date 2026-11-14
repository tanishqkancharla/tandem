# @tanishqkancharla/tandem-server

The server for [Tandem](https://github.com/tanishqkancharla/tandem), a sync engine and database for collaborative apps. `TandemServer` is a library: it runs inside your existing backend, accepts pushes and pulls from Tandem clients, and pokes them when data changes.

> [!WARNING]
> Tandem is pre-1.0. APIs change without notice.

```sh
pnpm add @tanishqkancharla/tandem-core @tanishqkancharla/tandem-server
```

```ts
import {
	createTandemEventStreamResponse,
	TandemServer,
	TandemServerJsonFileStorage,
} from "@tanishqkancharla/tandem-server"
import { schema, type AppSchema } from "./schema"

const server = new TandemServer({
	schema,
	relations: {},
	storage: new TandemServerJsonFileStorage<AppSchema>({
		filePath: "./data/tandem.json",
	}),
})

// Mount these in your HTTP framework, behind your own authentication:
// POST /api/tandem         -> server.push(args) or server.pull(args)
// GET  /api/tandem/events  -> createTandemEventStreamResponse({ remote: server, clientId, schema, signal })
```

The JSON file storage suits development. The `@tanishqkancharla/tandem-server/sql` entry holds experimental adapters for existing PostgreSQL, MySQL, and Cloudflare D1 tables.

Read the [documentation](https://docs.tandemsync.dev): [Server](https://docs.tandemsync.dev/server), [Choosing storage](https://docs.tandemsync.dev/sql), and [Authentication and permissions](https://docs.tandemsync.dev/permissions).
