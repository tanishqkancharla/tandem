# Tandem

!IMPORTANT: This is a work in progress and is not ready for use.

A sync engine and database for building collaborative apps.

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
- [ ] Pull should not return early if scan window is empty. Because pull still returns useful information with the `waitForAcknowledgement`
- [ ] Relational queries v2 https://www.notion.so/Relational-tandem-258ac9fb35f1801e88eaf858b5401317?source=copy_link
- [ ] Create a server module
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
