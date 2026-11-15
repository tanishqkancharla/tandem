# Phase 9: Feed the sync engine from Postgres

Phases [7](12-standalone-sync-engine.md) and [8](13-hosted-pub-sub.md) poke clients only for writes that go through `TandemServer`. This phase adds a `TandemChangeSource` for Postgres ([Library API](03-library-api.md#sync-engine)), so the sync engine pokes clients for any write to a mapped table: mode 3 in [Target architecture](02-target-architecture.md#mode-3-database-change-feed).

**Today**

A background job that updates `todos` in Postgres reaches clients only on their next fallback pull. Storage's `subscribe` hook could report it, but no SQL adapter implements it, and it would poke every client ([[packages/server/src/storage/TandemServerStorage.ts#TandemServerStorageApi]]).

**Proposed**

The sync engine service starts a Postgres change source. A write from any source pokes the clients subscribed to that record's channels within about a second, with no change to the job that wrote it.

```ts
const engine = new TandemSyncEngine({ verify })
const feed = postgresChangeSource({
	pool,
	tables, // the same TandemSqlTable mapping the server uses
	channels, // the same record channel function the server uses
	mode: "logical-replication", // or "notify"
})
await feed.start(engine)
```

## Two ways to read changes

| | Logical replication (`pgoutput`) | Triggers with `NOTIFY` |
| --- | --- | --- |
| App table changes | None | One trigger per mapped table |
| Database permissions | `REPLICATION` role and a slot | Ordinary |
| Survives sync engine downtime | Yes, from the slot's position in `tandem_feed_positions` | No; missed notifications are lost |
| Hosted Postgres support | Most (Neon, Supabase, RDS) with settings | All |
| Risk | An abandoned slot keeps WAL and fills the disk | 8 KB payload limit per notification |

Recommendation: ship triggers with `NOTIFY` first, since they work everywhere and a missed notification only delays a client until its fallback pull. Add logical replication when an app needs resumption.

## From a row to a publish

```callstack [postgresChangeSource]
+feed.start(publisher)
+├── LISTEN tandem_changes # or start replication from the saved position
+└── on notification { table, op, row, oldRow }:
+    ├── collection, record = decode with the table's TandemSqlTable.decode
+    ├── channels = channels.record(old) ∪ channels.record(new)
+    └── publisher.publish({ channels }) # bare poke; no Tandem revision
```

Writes made by `TandemServer` itself arrive twice: once from the server's publish, with a payload, and once from the feed. The client's pull queue coalesces them, so the cost is one extra poke per commit, not an extra pull. Apps that run only the feed can omit the server's publisher.

The trigger and function come from the migration helper in [Database metadata](04-database-metadata.md#fumadb-or-kysely), generated per mapped table:

```sql
create or replace function tandem_notify() returns trigger as $$
begin
  perform pg_notify('tandem_changes', json_build_object(
    'table', tg_table_name, 'op', tg_op,
    'row', row_to_json(new), 'old', row_to_json(old))::text);
  return null;
end $$ language plpgsql;

create trigger tandem_notify_todos after insert or update or delete on todos
  for each row execute function tandem_notify();
```

A row over the 8 KB limit sends only its key columns, and the source publishes the collection-level channel for it.

Tests: PGlite supports `LISTEN`/`NOTIFY`, so a server test writes with raw SQL and checks the client is poked. Logical replication tests need a real Postgres and run in CI only. `dst/` adds external writers that bypass the server, with checks that each one pokes subscribed clients when the feed is on.

```changes

```
