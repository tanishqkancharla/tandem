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

## Queries in SQL

On SQLite, D1, and PostgreSQL, `server.query`, `server.subscribe`, and sync pulls send filters, sorting, and limits to SQL when SQL gives the same answer as Tandem's query engine. Tandem still filters, sorts, and pages the rows SQL returns, so a clause SQL cannot decide only makes the read larger. One-to-many includes read the related rows for every parent in one statement. Queries inside `server.transact()` read whole tables, so they see the transaction's own writes.

SQL decides:

- equality on string, number, and boolean fields;
- `gt`, `gte`, `lt`, and `lte` on number fields;
- `orderBy` with `limit` on leading number fields. Tandem reads the rows tied with the last one, so ties still break by record ID.

Tandem filters and sorts the rest after reading: string ranges and string sorting, because Tandem compares UTF-16 code units and SQL collations do not; values of the wrong type; `NaN`, `Infinity`, strings with lone surrogates or NUL; fields without a column mapping; pages whose offset or limit is not a whole number of rows; and every collection whose schema uses a codec. Tandem does not send queries to MySQL, whose default collations ignore case.

On PostgreSQL, map string fields to `text` or `varchar` columns with deterministic collations, and number fields to `integer` or `double precision` columns, or `bigint` when the driver returns it as a number. A `citext`, `uuid`, or `real` column compares values differently from Tandem; leave such fields out of an explicit mapping's `fields`. SQLite comparisons use the binary collation whatever the column declares.

Indexes are yours to create. Index the columns your paged queries filter on, then the column they sort by, such as `create index messages_thread_recent on messages (thread_id, created_at)`. One index serves every query that filters on a prefix of its columns, so the number of indexes follows your query shapes, not your number of clients. Tandem never creates indexes or tables.

Tandem decodes only the rows SQL returns, so a row that cannot decode fails only the queries that read it. Number columns must hold values a JavaScript number represents exactly, such as SQLite integers within 2^53. PostgreSQL `NaN` works: Tandem treats it as tied with every number, as its query engine does. Node's built-in `node:sqlite` returns text only up to a NUL character, so such values do not round-trip through that driver with or without SQL queries.

## SQL limitations

These adapters are experimental. Application records persist, but mutation acknowledgements live in the adapter's memory. After a server restart, a pending mutation may replay or a client may receive a mutation-gap error. Reconnecting a stream restores subscriptions, not acknowledgements. Do not use these adapters where restart-safe writes are required yet.

Run synced writes through one `TandemServer`, including backend jobs. Multiple servers sharing a database do not share acknowledgements or the mutation queue. Direct SQL updates appear on the next pull, but the adapters do not notify connected clients about them. They also do not install row policies or pass authenticated user context to the database; enforce [permissions](permissions.md) in your app.

A paged read can take two or three statements, and an include over many parents one per 500 parents. Pulls run in order with writes through the same `TandemServer`. A write between the statements of a `server.query` call, or a direct SQL update, can produce a page that never existed at one moment; the next pull or subscription update corrects it.

Use primary keys whose equality matches record identity. Avoid case-insensitive collations when differently cased IDs are distinct. Database constraints still apply. Write batches remove records before setting records and do not sort writes by foreign-key dependency.
