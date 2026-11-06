# PostgreSQL

`TandemServerPostgresStorage` syncs collections with existing PostgreSQL tables through a `pg` pool. It uses the [shared SQL mapping](../sql.md#shared-sql-mapping) and atomic write batches.

The adapter is experimental: records persist, but mutation acknowledgements do not survive a server restart. Read the [SQL limitations](../sql.md#sql-limitations) before choosing it.

## Connect a pool

Install the driver in your application:

```sh
pnpm add pg
```

Given the shared `tasks` schema from [Choosing storage](../sql.md#shared-sql-mapping), create a matching table with your migration tool:

```sql
CREATE TABLE tasks (
  id TEXT PRIMARY KEY,
  text TEXT NOT NULL,
  done BOOLEAN NOT NULL DEFAULT FALSE
);
```

Pass a pool and the runtime schema to the adapter:

```ts
import pg from "pg"
import { TandemServer } from "@tanishqkancharla/tandem-server"
import { TandemServerPostgresStorage } from "@tanishqkancharla/tandem-server/sql"
import { schema } from "./schema"

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL })
const storage = new TandemServerPostgresStorage({ schema, database: pool })
const server = new TandemServer({ schema, relations: {}, storage })
```

The adapter uses Kysely's PostgreSQL driver for reads and transactions. Booleans stay native PostgreSQL booleans. Choose column types that the driver returns as JavaScript strings, numbers, or booleans; other types need [custom mappings](custom.md#custom-sql-mappings).

Your application owns the pool. On shutdown, stop its consumers, call `server.close()`, then call `pool.end()`. Tandem does not create tables or run migrations.
