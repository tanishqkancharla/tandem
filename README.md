# Tandem

!IMPORTANT: This is a work in progress and is not ready for use.

A sync engine and database for building collaborative apps.
- [x]  Basic database
    - [x]  getRecord
    - [x]  listRecords
    - [x]  setRecord
    - [x]  removeRecord
- [x]  Database work
    - [x]  Mutation stream to storage
    - [x]  Rollback on failure
- [x]  Storage
    - [x]  Mount from storage on initialization
- [x]  Remote api
    - [x]  Implement push
    - [x]  Implement pull
    - [x]  Implement poke
    - [x]  Stream mutations to remote
    - [x]  Apply mutations on remote
    - [x]  Stream delta changes back to database (pull)
    - [x]  Replay: when fetching new changes, rollback pending mutations, apply changes, and then re-apply optimistic/pending mutations on top.
- [x]  Split up mutation into mutation and invertible mutations
- [x]  Implement scan window
- [x]  Remote keeps track of last scan windows and pokes only for intersecting scan windows
- [x]  Query dialect
    - [x]  `select`
    - [x]  `where`
    - [x]  `order`
    - [x]  `limit`
- [x]  Make repo public
- [ ]  Add docs
- [ ]  Think about backwards compatibility -- how does mounting from a persisted storage work with new versions?
    - [ ]  New database versions
    - [ ]  Schema changes
- [ ]  Consider a different query language based on typescript indexes.
    - Notes
        pure function: record ⇒ value
        access via index directly
        allows for compound/cross-table indexes
- [ ]  Query upgrades
    - [ ]  Nested attribute queries:
        - [ ]  `q.where("status.type", "=", TaskStatusType.Snoozed).where("status.until", "<", now)`
- [ ]  Relations
- [ ]  Object support
- [ ]  Permissions 😭
- [ ]  Database updates
    - [ ]  Keep codec translating between query language and tuple storage args
- [ ]  Clear storage when user schema or database storage protocol changes
    - [ ]  Create a storage protocol mapping records, indexes, etc. to tuple storage
    - [ ]  Add ability to pass in runtime user schema
- [ ]  Build testing framework
    - [ ]  Manual tests
    - [ ]  Automated randomized testing — do a bunch of reads and writes, inject random failures
    - [ ]  Step-by-step debugger (with ability to query any db at any point)
- [ ]  Look into memory usage
- [ ]  Allow object records in schema
- [ ]  Mutation tagged with intents
- [ ]  Think about conflict resolution: two places it can happen:
    - [ ]  When applying mutations on server
    - [ ]  When re-applying optimistic mutations
- [ ]  Testing
    - [ ]  Perf
    - [ ]  Robustness
        - [ ]  Every API boundary can throw or fail
        - [ ]  Every state boundary can be stale:
            - [ ]  Storage can be ahead/behind
            - [ ]  Backend can be ahead/behind
    - [ ]  Migration tests: test database can be opened on previous version of storage
- [ ]  Build integrations
    - [ ]  Notion
    - [ ]  Gmail
    - [ ]  Google Calendar
    - [ ]  Github
