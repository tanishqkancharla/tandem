# Phase 1: Store client acknowledgements in the database

[Database metadata](04-database-metadata.md) defined `tandem_clients`. This phase writes it from the SQL adapters, so a push retried after a restart is not applied twice. It is the first step because every later mode needs it, and it fixes a bug in today's single-process mode.

**Today**

A client pushes mutation 5 to a server on SQL storage. The server writes the record to SQL and the acknowledgement to an in-memory map. If the server restarts and the client retries, the server sees `lastMutationId` 0 and applies mutation 5 again. For a counter or a text append, the user sees the effect twice.

**Proposed**

The acknowledgement goes to `tandem_clients` in the same SQL batch as the records, so a retry after a restart is skipped. Apps add the table with Tandem's migration.

`TandemServerSqlStorage` routes `["client", id]` tuples to the metadata table instead of `InMemoryTupleStorage`:

```callstack [SqlStorage.commit]
 TandemServerSqlStorage.commit(writes) [[packages/server/src/storage/TandemServerSqlStorage.ts#TandemServerSqlStorage.commit]]
 ├── statements = this.statements(writes) # record tables
+├── statements.push(upsert tandem_clients for each ["client", id] write)
 ├── commitSql(statements) # one atomic batch
-└── this.clients.commit(client writes) # memory only
+└── return
```

```callstack [SqlStorage.scan]
 TandemServerSqlStorage.scan(args) [[packages/server/src/storage/TandemServerSqlStorage.ts#TandemServerSqlStorage.scan]]
-├── memory = new InMemoryTupleStorage(this.clients.scan())
+├── if prefix allows ["client"]: select from tandem_clients, decode to ["client", id] tuples
 └── read record tables as today
```

The upsert uses the same update-then-insert pattern as records, since `on conflict` syntax differs by dialect:

```ts
function clientStatements(clientId: ClientId, lastMutationId: MutationId, now: number) {
	return [
		sql`update tandem_clients set last_mutation_id = ${lastMutationId}, updated_at = ${now}
		    where client_id = ${clientId}`,
		sql`insert into tandem_clients (client_id, last_mutation_id, updated_at)
		    select ${clientId}, ${lastMutationId}, ${now}
		    where not exists (select 1 from tandem_clients where client_id = ${clientId})`,
	].map((statement) => statement.compile(this.compiler))
}
```

The migration helper ships here with this one table, as `tandemMigrations` from `@tanishqkancharla/tandem-server/sql`. The Cloudflare example's `schema.sql` and the storage docs gain the table.

Tests: the SQL storage suite ([[packages/server/test/TandemServerSqlStorage.spec.ts]]) restarts the server between a push and its retry, on SQLite, PGlite, and MySQL, and checks the mutation applies once. `dst/` already crashes servers; its SQL storage run should now pass the duplicate-mutation check that it would fail today.

```changes

```
