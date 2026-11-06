# Choosing storage

Tandem separates the server's source of truth from the client's local cache. Choose a server adapter below; browser clients can independently persist their local replica to IndexedDB through [client storage](client.md#persistence).

| Server adapter                       | Stores records in           | Use it for                                   |
| ------------------------------------ | --------------------------- | -------------------------------------------- |
| [PostgreSQL](storage/postgresql.md)  | Existing PostgreSQL tables  | Applications using a `pg` pool               |
| [MySQL](storage/mysql.md)            | Existing MySQL tables       | Applications using a `mysql2` pool           |
| [Cloudflare D1](storage/d1.md)       | Existing D1 tables          | Workers with a D1 binding                    |
| [JSON file](storage/json-file.md)    | A local JSON file           | Development and examples                     |
| [Custom adapters](storage/custom.md) | Your storage or SQL mapping | Other databases, table names, or value types |

For a full Cloudflare deployment with D1 storage and a Durable Object hosting the server, follow [Deploy on Cloudflare](cloudflare.md).

## Shared SQL mapping

The PostgreSQL, MySQL, and D1 adapters take the same runtime schema used by clients:

```ts
import { collection, defineSchema, t } from "@tanishqkancharla/tandem-core"

export const schema = defineSchema({
	tasks: collection({ id: t.id(), text: t.string(), done: t.boolean() }),
})
```

Collection names match table names, field names match column names, and each table has an `id` primary key. The built-in mapping supports scalar string or number IDs and the builder's string, number, and boolean fields. Field-name-only definitions such as `collection<Task>({ fields: [...] })` need an [explicit mapping](storage/custom.md#custom-sql-mappings) because TypeScript types do not exist at runtime.

Only mapped fields enter Tandem records or get updated. Other columns stay under application control; new rows still need values or database defaults for required unmapped columns. Tandem does not create tables, alter them, or add sync columns. See [Schema changes and client compatibility](migrations.md).

The adapters convert booleans to `0`/`1` for D1 and MySQL and use native booleans for PostgreSQL. Dates, JSON, nullable fields, decimals returned as strings, and compound IDs need custom mappings. The application owns its database handle; `server.close()` does not close a borrowed pool or binding.

## SQL limitations

These adapters are experimental. Application records persist, but mutation acknowledgements live in the adapter's memory. After a server restart, a pending mutation may replay or a client may receive a mutation-gap error. Reconnecting a stream restores subscriptions, not acknowledgements. Do not use these adapters where restart-safe writes are required yet.

Run synced writes through one `TandemServer`, including backend jobs. Multiple servers sharing a database do not share acknowledgements or the mutation queue. Direct SQL updates appear on the next pull, but the adapters do not notify connected clients about them. They also do not install row policies or pass authenticated user context to the database; enforce [permissions](permissions.md) in your app.

Scans read current rows. Shared ID prefixes become SQL equality constraints; remaining bounds, sorting, limits, filters, and relation queries run in memory through Tandem's query engine. General SQL predicate and join pushdown is not supported.

Use primary keys whose equality matches record identity. Avoid case-insensitive collations when differently cased IDs are distinct. Database constraints still apply. Write batches remove records before setting records and do not sort writes by foreign-key dependency.
