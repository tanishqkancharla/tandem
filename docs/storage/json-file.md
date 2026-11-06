# JSON file

`TandemServerJsonFileStorage` persists application records and mutation acknowledgements in a local JSON file. It reads the stored tuples and writes the whole file on each commit. Use it for development and examples.

```ts
import {
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
```

The adapter creates the parent directory when writing and publishes commits by replacing the file through a temporary file. The file's internal tuple format is not an application-facing migration interface.

Keep one server responsible for writes to a file. Cookies, revisions, and connected client views remain in memory and rebuild after a server restart. Call `server.close()` when shutting down.

The [Quickstart](../quickstart.md#5-add-a-server) uses this adapter. For existing application tables, choose [PostgreSQL](postgresql.md), [MySQL](mysql.md), or [D1](d1.md).
