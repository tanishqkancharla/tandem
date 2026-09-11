# TODO

## Naming cleanup

- Rename `Database` and `DatabaseArgs` to `TandemDatabase` and `TandemDatabaseArgs`.
- Rename the client `Transaction` to `TandemClientTransaction`.
- Prefix Tandem's structural tuple-database views with `Tuple`: `CollectionTransactionApi`, `CollectionScanApi`, `AsyncCollectionScanApi`, and `WriteOpsApi`.
- Remove the redundant `Relational` prefix from the public query types: `Query`, `QueryOptions`, `QueryResult`, `QueryRow`, `SelectOptions`, `WhereOptions`, `OrderByOptions`, and `WithOptions`. Rename `_encodeRelationalQuery` to `encodeQuery`; keep `EncodedQuery` for the sync protocol representation.
- Correct `InveribleSetMutationOp` and `InveribleRemoveMutationOp` to `InvertibleSetMutationOp` and `InvertibleRemoveMutationOp`.

## Remove the legacy remote stack

- Remove `RemoteServer`, `RemoteStore`, `InMemoryRemote`, `JsonFileRemote`, and the Drizzle remote adapters after `TandemServer` replaces the `RemoteApi` `connect`/`push`/`pull` path used by `TandemClient` and `SyncEngine`.
- Remove the corresponding exports, package subpaths, tests, fixtures, and documentation in the same change.
