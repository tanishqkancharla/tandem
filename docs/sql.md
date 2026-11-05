# Existing SQL tables

Sync Tandem collections into your application's SQL tables by supplying your Tandem schema and a database handle. Built-in adapters handle reads, bound parameters, and atomic writes for D1, PostgreSQL, and MySQL.

These adapters are experimental. Application records persist in SQL, but mutation acknowledgements live in the adapter's memory. After a server restart, a pending mutation may replay or a client may receive a mutation-gap error. Reconnecting SSE restores subscriptions, not acknowledgements. Durable sync metadata is separate work; do not use these adapters where restart-safe writes are required yet.

## Reuse your collection definitions

Collection names match table names, field names match column names, and each table has an `id` primary key. Use runtime field definitions so the adapter can convert values:

```ts
import { collection, defineSchema, t } from "@tanishqkancharla/tandem-core"

export const schema = defineSchema({
  tasks: collection({ id: t.id(), text: t.string(), done: t.boolean() }),
})
```

This schema maps to `tasks(id, text, done)`. The simple path supports scalar string or number IDs and the builder's string, number, and boolean fields. The older `collection<Task>({ fields: [...] })` form only provides field names; it needs an explicit mapping because TypeScript types do not exist at runtime.

For D1, a matching table is:

```sql
CREATE TABLE tasks (
  id TEXT PRIMARY KEY,
  text TEXT NOT NULL,
  done INTEGER NOT NULL DEFAULT 0,
  audit_note TEXT
);
```

The adapter converts booleans to `0`/`1` for D1 and MySQL, and uses native booleans for PostgreSQL. Use SQL column types that the driver returns as JavaScript strings, numbers, or booleans. Types such as dates, JSON, nullable fields, decimals returned as strings, and compound IDs need custom mappings.

Only fields declared in the schema enter Tandem records or get updated. `audit_note` stays under the application's control. New rows still need values or database defaults for every required unmapped column. Tandem does not create or alter tables, or add sync columns.

Use your application's migration tool for schema changes and backfills. [Migrations](migrations.md) also covers old clients and pending writes; changing a table alone does not upgrade either. The adapters do not configure database row policies or authenticated user context. See [Permissions](permissions.md) for read and write access.

## Connect a database

Import adapters from the server package's `/sql` entry. For D1, pass the existing binding:

```ts
import { TandemServerD1Storage } from "@tanishqkancharla/tandem-server/sql"

const storage = new TandemServerD1Storage({ schema, database: env.DB })
```

For PostgreSQL, pass a `pg` pool. Tandem uses Kysely's PostgreSQL driver to execute reads and run each write batch in one transaction:

```ts
import pg from "pg"
import { TandemServerPostgresStorage } from "@tanishqkancharla/tandem-server/sql"

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL })
const storage = new TandemServerPostgresStorage({ schema, database: pool })
```

For MySQL, pass a `mysql2` callback pool, without calling `.promise()`:

```ts
import mysql from "mysql2"
import { TandemServerMysqlStorage } from "@tanishqkancharla/tandem-server/sql"

const pool = mysql.createPool(process.env.DATABASE_URL!)
const storage = new TandemServerMysqlStorage({ schema, database: pool })
```

The adapter class selects the SQL dialect. Install the driver for your database in your application; Tandem does not bundle `pg` or `mysql2`.

Pass the adapter to `TandemServer` with the same schema used by clients:

```ts
import { TandemServer } from "@tanishqkancharla/tandem-server"

const server = new TandemServer({ schema, relations: {}, storage })
```

Client queries and mutations use the same interface as other storage adapters. The application owns its database handle: `server.close()` leaves the binding or pool open. Close your pool after its consumers stop. See the [Cloudflare guide](cloudflare.md) for a complete Worker and SSE setup.

## Custom tables and drivers

Use the lower-level `TandemServerSqlStorage` when your physical schema differs from the collection schema or your driver is not covered above:

```ts
import {
  TandemServerSqlStorage,
  type TandemSqlTable,
} from "@tanishqkancharla/tandem-server/sql"

type Task = { id: string; text: string; done: boolean }
const tasksTable: TandemSqlTable<Task> = {
  table: "app_tasks",
  idColumns: ["task_id"],
  encode: ({ text, done }) => ({ title: text, is_done: Number(done) }),
  decode: (row) => ({
    id: row.task_id as string,
    text: row.title as string,
    done: row.is_done === 1,
  }),
}

const storage = new TandemServerSqlStorage<{ tasks: Task }>({
  dialect: "sqlite",
  tables: { tasks: tasksTable },
  query: async ({ sql, parameters }) =>
    (await env.DB.prepare(sql).bind(...parameters).all()).results,
  commit: async (statements) => {
    await env.DB.batch(statements.map(({ sql, parameters }) =>
      env.DB.prepare(sql).bind(...parameters),
    ))
  },
})
```

Here `dialect` selects `sqlite`, `postgres`, or `mysql` syntax. `query` returns rows, and `commit` must execute every statement atomically or reject with the whole batch rolled back. Pass parameters to the driver's binding API, never interpolate them into SQL strings. Kysely compiles the statements; these callbacks own execution.

`encode` returns mapped column values. `decode` returns a complete record, including its ID. For compound IDs, list primary-key columns in the same order as the ID parts. You can also pass `schema` and provide `tables` overrides only for collections that need custom mappings.

Internally, Tandem addresses records with tuple keys such as `["record", "tasks", "task-1"]`. The adapter translates those keys to the table and primary-key columns. It does not store key arrays or copy records into another table.

## Current scope

Run writes to synced records through one `TandemServer`, including writes from backend jobs. Multiple servers sharing a database do not share acknowledgements or the mutation queue. Direct SQL changes become visible on the next pull, but these adapters do not notify connected clients about them.

Scans read current SQL rows. Shared ID prefixes become SQL equality constraints; remaining bounds, sorting, and limits run in memory over decoded rows for that scan. General filters and relation queries use Tandem's existing query engine rather than SQL joins or predicate pushdown. Large collections can therefore be expensive even when a query returns few records.

Use primary keys whose equality matches your application's record identity; avoid case-insensitive string-key collations if differently cased IDs are distinct records. Database constraints still apply. Batches remove records before setting records, in the order provided by Tandem; they do not sort writes by foreign-key dependency.

Tests exercise D1's local runtime, PostgreSQL through PGlite, and live PostgreSQL and MySQL pools. The live pool suites run when `TANDEM_POSTGRES_URL` and `TANDEM_MYSQL_URL` are set.

## References

- [Kysely query compilation](https://www.kysely.dev/docs/recipes/splitting-query-building-and-execution)
- [D1 batches](https://developers.cloudflare.com/d1/worker-api/d1-database/#batch)
