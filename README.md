# Tandem

!IMPORTANT: This is a work in progress and is not ready for use.

A sync engine and database for building collaborative apps.

## Server

`TandemServer` is the server-side database and the implementation of the
current `RemoteApi` sync contract. It accepts the same runtime schema and
relations as the client plus a durable tuple-storage adapter.

```ts
import {
  collection,
  defineSchema,
  t,
  TandemClient,
} from "@tanishqkancharla/tandem-core"
import {
  TandemServer,
  TandemServerJsonFileStorage,
} from "@tanishqkancharla/tandem-server"

type TodoSchema = {
  todos: {
    id: string
    text: string
    complete: boolean
  }
}

const schema = defineSchema({
  todos: collection({
    id: t.id(),
    text: t.string(),
    complete: t.boolean(),
  }),
})

const server = new TandemServer<TodoSchema, {}>({
  schema,
  relations: {},
  storage: new TandemServerJsonFileStorage<TodoSchema>({
    filePath: "./data/tandem.json",
  }),
})
```

The client still receives a transport through its `remote` option. An HTTP or
RPC adapter forwards that unchanged `RemoteApi` contract to `TandemServer`.

```ts
const client = new TandemClient({
  schema,
  remote: todoHttpRemote,
})
```

Application tuples are durable when the configured storage is durable. Sync
metadata such as revisions, mutation acknowledgements, and client scan windows
currently lives in the `TandemServer` process and resets when it restarts.

- [x] Basic database
  - [x] getRecord
  - [x] listRecords
  - [x] setRecord
  - [x] removeRecord
- [x] Database work
  - [x] Mutation stream to storage
  - [x] Rollback on failure
- [x] Storage
  - [x] Mount from storage on initialization
- [x] Remote api
  - [x] Implement push
  - [x] Implement pull
  - [x] Implement poke
  - [x] Stream mutations to remote
  - [x] Apply mutations on remote
  - [x] Stream delta changes back to database (pull)
  - [x] Replay: when fetching new changes, rollback pending mutations, apply changes, and then re-apply optimistic/pending mutations on top.
- [x] Split up mutation into mutation and invertible mutations
- [x] Implement scan window
- [x] Remote keeps track of last scan windows and pokes only for intersecting scan windows
- [x] Query dialect
  - [x] `select`
  - [x] `where`
  - [x] `order`
  - [x] `limit`
- [x] Make repo public
- [x] Add docs
- [x] Switch to pnpm monorepo
- [x] Pull should not return early if scan window is empty. Because pull still returns useful information with the `waitForAcknowledgement`
- [ ] Relational queries v2 https://www.notion.so/Relational-tandem-258ac9fb35f1801e88eaf858b5401317?source=copy_link
  - Runtime schemas and schema-owned codecs are foundation work only; relational object-style queries are deferred to later specs.
  - [x] Runtime schemas
    - [x] Runtime collection definitions
    - [x] Schema-owned codecs for storage/network values
    - [x] Basic relation metadata via `defineRelations`
  - [x] Finalize public relational query shape
    - Design: `docs/relational-queries-design.md`
    - [x] Object-style query API: `useQuery({ collection: "threads", select, where, with, orderBy, limit })`
    - [x] Decide exact `select`, `where`, `orderBy`, `limit`, and `offset` syntax
    - [x] Decide relation result shape for `many-to-one` vs `one-to-many`
  - [x] Type inference for relational queries
    - Spec: `specs/type-inference-for-relational-queries.md`
    - [x] Infer selected scalar fields
    - [x] Infer nested `with` results
    - [x] Preserve relation cardinality: `many-to-one` as object/null, `one-to-many` as array/collection
    - [x] Validate relation names and selected fields at compile time
  - [x] Encode relational queries
    - [x] Extend `EncodedQuery` with an include/with tree
    - [x] Encode nested relation options: `select`, `where`, `order`, and `limit`
    - [x] Keep flat query encoding compatible with the current query execution path, or replace it cleanly
  - [x] Execute relational queries locally
    - [x] Teach `Database.query` to resolve `many-to-one` and `one-to-many` relations from schema metadata
    - [x] Support nested includes
    - [x] Support per-relation `where`, `orderBy`, and `limit`
    - [x] Ensure parent `select` can omit fields needed internally for relation joins
  - [x] Subscribe to relational queries locally
    - [x] Recompute/emit when included child records change
    - [x] Handle nested relation changes
    - [x] Define whether child changes re-emit parent rows or expose live child collections
  - [x] Make object query API canonical
    - [x] Use a single query object with explicit `collection`
    - [x] Rename `run` to `query`
    - [x] Replace fluent `QueryBuilder` call sites with object queries
    - [x] Remove `q`/`QueryBuilder` from the public API
    - [x] Keep internal encoding/execution helpers private
  - [x] Sync relational subscriptions through remote
    - Spec: `specs/sync-relational-subscriptions-through-remote.md`
    - [x] Include relation include-tree in scan windows
    - [x] Remote pull returns records needed for requested relations
    - [x] Remote poke/intersection logic accounts for child collections that affect subscribed relational queries
    - [x] Patch application keeps optimistic replay semantics working with relation-expanded results
  - [ ] Tests and examples
    - [x] Thread list with last message
    - [ ] Thread detail query
    - [x] `many-to-one` relation example, e.g. task → patient
    - [x] `one-to-many` relation example, e.g. thread → messages
    - [x] Nested relation example
    - [x] Local run coverage
    - [x] Local subscribe coverage
    - [x] Remote sync coverage
- [x] Create a server module
  - [x] Add a typed `TandemServer` database and durable storage contract
  - [x] Implement the current `RemoteApi` on `TandemServer`
  - [ ] Add database-backed invalidation for server storage adapters
    - Current pokes are emitted by a `TandemServer` instance after it commits writes.
    - Future storage adapters should support database-originated change notifications so multi-process servers and direct database writes can poke subscribed clients.
    - Likely shape: keep snapshot reads as the source of truth, add optional store invalidations, and use database-native mechanisms such as Postgres `LISTEN`/`NOTIFY` plus triggers to emit coarse collection/id changes.
    - Start with collection-level invalidation for correctness, then refine query-aware matching later as an optimization.
- [ ] Nested remote idea: be able to define remote data sources on a subspace
- [ ] Rebuild query engine as incremental using https://github.com/electric-sql/d2ts
- [ ] Think about backwards compatibility -- how does mounting from a persisted storage work with new versions?
  - [ ] New database versions
  - [ ] Schema changes
- [ ] Consider a different query language based on typescript indexes.
  - Notes
    pure function: record ⇒ value
    access via index directly
    allows for compound/cross-table indexes
- [ ] Database updates
  - [ ] Keep codec translating between query language and tuple storage args
- [ ] Clear storage when user schema or database storage protocol changes
  - [ ] Create a storage protocol mapping records, indexes, etc. to tuple storage
  - [ ] Add ability to pass in runtime user schema
- [ ] Look into memory usage
- [ ] Allow object records in schema
- [ ] Mutation tagged with intents
- [ ] Think about conflict resolution: two places it can happen:
  - [ ] When applying mutations on server
  - [ ] When re-applying optimistic mutations
- [ ] Testing
  - [ ] Perf
  - [ ] Robustness
    - [ ] Every API boundary can throw or fail
    - [ ] Every state boundary can be stale:
      - [ ] Storage can be ahead/behind
      - [ ] Backend can be ahead/behind
  - [ ] Migration tests: test database can be opened on previous version of storage
- [ ] Build integrations
  - [ ] Notion
  - [ ] Gmail
  - [ ] Google Calendar
  - [ ] Github
