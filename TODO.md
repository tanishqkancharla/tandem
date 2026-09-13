# TODO

## Naming cleanup

- Rename `Database` and `DatabaseArgs` to `TandemDatabase` and `TandemDatabaseArgs`.
- Rename the client `Transaction` to `TandemClientTransaction`.
- Prefix Tandem's structural tuple-database views with `Tuple`: `CollectionTransactionApi`, `CollectionScanApi`, `AsyncCollectionScanApi`, and `WriteOpsApi`.
- Remove the redundant `Relational` prefix from the public query types: `Query`, `QueryOptions`, `QueryResult`, `QueryRow`, `SelectOptions`, `WhereOptions`, `OrderByOptions`, and `WithOptions`. Rename `_encodeRelationalQuery` to `encodeQuery`; keep `EncodedQuery` for the sync protocol representation.
- Correct `InveribleSetMutationOp` and `InveribleRemoveMutationOp` to `InvertibleSetMutationOp` and `InvertibleRemoveMutationOp`.

## Server sync follow-up

- Persist server revisions, client mutation acknowledgements, scan windows, and synced record keys.
- Decide whether the next protocol keeps the current `remote` terminology.
- Specify reset versus incremental pull behavior.
- Specify retry and idempotency semantics for pushes and pulls.
- Build a production Drizzle `TandemServerStorageApi` adapter.
