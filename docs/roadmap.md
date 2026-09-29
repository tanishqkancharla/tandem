# Roadmap

Short-term cleanup tasks live in [`TODO.md`](../TODO.md).

## In progress

- Relational query examples
  - [ ] Thread detail query
- Server
  - [ ] Database-backed invalidation for server storage adapters. Pokes currently come only from the `TandemServer` instance that committed a write. Storage adapters should report database-originated changes, for example through Postgres `LISTEN`/`NOTIFY` and triggers, so multi-process servers and direct database writes can poke subscribed clients. Start with collection-level invalidation, then refine to query-aware matching.
  - [ ] Persist sync metadata: revisions, acknowledged mutation IDs, scan windows, and synced record keys
  - [ ] Production Drizzle storage adapter

## Planned

- Protocol
  - [ ] Specify reset versus incremental pull
  - [ ] Specify retry and idempotency semantics for push and pull
- Conflict resolution
  - [ ] Tag mutations with intents
  - [ ] Define conflict handling when the server applies mutations
  - [ ] Define conflict handling when the client replays optimistic mutations
- Versioning
  - [ ] Handle new database versions when mounting persisted storage
  - [ ] Handle schema changes
  - [ ] Clear client storage when the schema or storage protocol changes
- Query engine
  - [ ] Rebuild as an incremental engine, possibly on [d2ts](https://github.com/electric-sql/d2ts)
  - [ ] Explore index-based queries: pure `record => value` functions that allow compound and cross-collection indexes
- Schema
  - [ ] Nested object fields
  - [ ] Remote data sources on a subspace
- Testing
  - [ ] Performance
  - [ ] Every API boundary can throw or fail
  - [ ] Storage and backend can each be ahead of or behind the client
  - [ ] Opening a database on a previous storage version
  - [ ] Memory usage
- Integrations
  - [ ] Notion
  - [ ] Gmail
  - [ ] Google Calendar
  - [ ] GitHub

## Done

- Local database with `get`, `list`, `set`, `update`, and `remove`
- Mutation stream to client storage, rollback on failure, and mounting from storage on startup
- Sync engine with push, pull, poke, and replay of pending mutations on top of pulled patches
- Invertible mutations
- Scan windows, so clients pull only the data they subscribe to
- Object queries with `select`, `where`, `orderBy`, `limit`, and `offset`
- Runtime schemas, schema-owned codecs, and `defineRelations`
- Relational queries: typed `with` includes, nested relations, local execution and subscriptions, and sync of related records ([design](design/relational-queries.md))
- Compound tuple IDs with prefix scans
- `TandemServer` with a durable storage contract and JSON file storage
- React bindings
- pnpm and Turborepo monorepo
- Deterministic simulation testing
