# Custom storage adapters

Use a custom SQL mapping when your tables differ from Tandem's collection schema. Implement `TandemServerStorageApi` when your backend needs a different storage API.

## Custom SQL mappings

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
		(
			await env.DB.prepare(sql)
				.bind(...parameters)
				.all()
		).results,
	commit: async (statements) => {
		await env.DB.batch(
			statements.map(({ sql, parameters }) =>
				env.DB.prepare(sql).bind(...parameters),
			),
		)
	},
})
```

Here `dialect` selects `sqlite`, `postgres`, or `mysql` syntax. `query` returns rows, and `commit` must execute every statement atomically or reject with the whole batch rolled back. Pass parameters to the driver's binding API, never interpolate them into SQL strings. Kysely compiles the statements; these callbacks own execution.

`encode` returns mapped column values. `decode` returns a complete record, including its ID. For compound IDs, list primary-key columns in the same order as the ID parts. You can also pass `schema` and provide `tables` overrides only for collections that need custom mappings.

List `fields` that a column holds unchanged, so [queries can filter and sort on them in SQL](../sql.md#queries-in-sql):

```ts
const tasksTable: TandemSqlTable<Task> = {
	// ...
	fields: { text: { column: "title", type: "string" } },
}
```

A `boolean` field must use `0`/`1` on SQLite and `boolean` on PostgreSQL. Mark a column that may hold NULL with `nullable: true`; `decode` should then return the field as `null` or leave it out. Queries filter fields you leave out, such as `done` above, after reading rows.

Internally, Tandem addresses records with tuple keys such as `["record", "tasks", "task-1"]`. The adapter translates those keys to the table and primary-key columns. It does not store key arrays or copy records into another table.

The built-in SQL adapter's [limitations](../sql.md#sql-limitations) apply to custom SQL mappings too, including in-memory mutation acknowledgements.

## Other storage backends

`TandemServer` accepts a `TandemServerStorageApi<Schema>` with these methods:

| Method                 | Contract                                                                                        |
| ---------------------- | ----------------------------------------------------------------------------------------------- |
| `scan(args?)`          | Read stored tuples within the tuple-database scan bounds.                                       |
| `commit(writes)`       | Apply the whole write batch atomically, including record changes and mutation acknowledgements. |
| `close()`              | Release resources owned by the adapter.                                                         |
| `subscribe(onChange)`  | Optional: notify after external changes become readable; return an unsubscribe function.        |
| `readCandidates(read)` | Optional: return every record a query node could select, in key order, or `undefined` to scan.  |

The tuple union includes application records and per-client mutation acknowledgements. Persist both if accepted mutations must not run again after a restart. Use the exported `TandemTuple` and `TandemServerStorageApi` types from `@tanishqkancharla/tandem-server` rather than defining a second tuple format.

Storage notifications ask connected clients to pull; they do not carry records. Notify only after the new values are readable through `scan`, and do not await client pulls inside the callback. Duplicate notifications are allowed.

Client persistence uses a separate `TandemClientStorageApi`, including `clear()` and atomic durable writes. See [Client persistence](../client.md#persistence); a server adapter is not a client cache.
