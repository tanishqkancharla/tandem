# Database metadata

[Target architecture](02-target-architecture.md) moves all state the server keeps between requests into the database. This page lists those tables, says which modes need each, and compares fumadb with Kysely for defining them.

## Tables

The server needs one table in every mode, and two more when several instances serve one scope. The sync engine needs one only when it reads a change feed.

```sql
-- Required. Written in the same transaction as the mutation's record writes.
create table tandem_clients (
  client_id        text primary key,
  last_mutation_id bigint not null,
  updated_at       bigint not null  -- for expiring abandoned clients
);

-- Stateless servers on Postgres or MySQL (Phase 6). Holds no data: commits lock their scope's row.
create table tandem_scopes (
  scope text primary key            -- one row per data scope; "default" for most apps
);

-- Optional. Lets a stateless server send diffs instead of resets (Phase 6).
create table tandem_client_views (
  client_id  text primary key,
  cookie     text not null,
  view       blob not null,         -- record id -> fingerprint, compressed
  updated_at bigint not null
);

-- Sync engine with a change feed only (Phase 9).
create table tandem_feed_positions (
  source   text primary key,
  position text not null            -- Postgres LSN, for example
);
```

What each replaces today:

| Table | Replaces | Read on | Written on |
| --- | --- | --- | --- |
| `tandem_clients` | `["client", clientId]` tuples, in memory for SQL adapters | Every push and pull | Every acknowledged mutation |
| `tandem_scopes` | The run queue ([[packages/server/src/TandemServer.ts#TandemServer.run]]) | Locked by every commit | Once per scope |
| `tandem_client_views` | `syncClients[id].view` and `.cookie` | Pulls with a cookie | Pulls that change the view |
| `tandem_feed_positions` | Nothing | Sync engine start | Every few seconds |

Nothing stores subscriptions or connections: channels are recomputed on each pull and held by the sync engine only in memory.

Application tables stay as they are. The SQL adapter maps collections onto existing tables ([[packages/server/src/storage/TandemServerSqlStorage.ts#TandemSqlTable]]) and this plan keeps that: no version columns or tombstones in app tables. The change feed in [Phase 9](14-postgres-change-feed.md) is the one opt-in exception, because trigger-based feeds need triggers on app tables.

## Cost and retention

- `tandem_clients` grows by one row per client ID, and core rotates IDs on `clear()`. Rows idle past a retention window, such as 30 days, can be deleted; a client that returns after that gets a mutation-gap error and must clear, which matches Replicache's client expiry.
- `tandem_scopes` is one hot row per scope. Every commit in a scope takes its row lock, so commits in a scope serialize. Today's run queue serializes them anyway, so this is no loss; apps with heavy write traffic can split scopes. On Postgres, `pg_advisory_xact_lock` gives the same lock with no table; MySQL's `GET_LOCK` is held per session rather than per transaction, so the row is simpler to use on both.
- `tandem_client_views` costs one write per pull that changes a view. Today the server keeps the same data in memory: one key and one 64-character fingerprint per record per client ([[docs/server.md]]).

## fumadb or Kysely

[fumadb](https://github.com/fuma-nama/fumadb) lets a library declare its tables once and generates migrations for the app's ORM: Kysely, Drizzle, Prisma, TypeORM, and MongoDB. That is exactly the problem a library with its own tables has. But for Tandem today:

| | fumadb | Kysely (recommended) | Plain SQL files |
| --- | --- | --- | --- |
| Already a dependency | No | Yes, in the SQL adapters | n/a |
| Version | 0.7.x, pre-1.0 | 0.29, stable | n/a |
| Runtime dependencies added | zod, commander, @clack/prompts, cuid2 | None | None |
| Drizzle and Prisma users | Generated migrations | Copy the SQL Tandem prints | Copy the SQL |
| D1 and Durable Object SQLite | Unclear; needs checking | SQLite dialect works today | Works |
| Fits the `query` / `commit` host contract | Needs its own connection | Yes, compile-only like today | Yes |

Recommendation: define the metadata tables with Kysely's schema builder, compiled per dialect the way [[packages/server/src/storage/TandemServerSqlStorage.ts#TandemServerSqlStorage]] compiles queries today. Ship them as:

```ts
import { tandemMigrations } from "@tanishqkancharla/tandem-server/sql"

// Kysely users: plug into Kysely's Migrator.
new Migrator({ db, provider: tandemMigrations.kysely() })

// Everyone else: the statements for their own migration tool.
tandemMigrations.statements("postgres") // TandemSqlStatement[]
```

With four small tables, fumadb's breadth does not pay for its runtime weight and pre-1.0 churn, and Workers bundles feel both. Revisit it if Tandem adds MongoDB or Convex, or if Drizzle and Prisma users ask for generated migrations.

## Where it lands

Three phases add these tables: [Phase 1](06-durable-client-acks.md) adds `tandem_clients`, and [Phase 6](11-stateless-pulls.md) adds `tandem_scopes` and `tandem_client_views`. [Phase 9](14-postgres-change-feed.md) adds `tandem_feed_positions` to the sync engine's database connection.
