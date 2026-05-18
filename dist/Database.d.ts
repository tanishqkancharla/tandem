import { type TupleRootTransactionApi } from "tuple-database";
import { Transaction } from "./transaction/Transaction";
import { AnySchema, RngApi, RelationalQuery, RelationalQueryResult, RuntimeRelationsDefinition, RuntimeSchemaDefinition, StorageApi } from "./types";
import { Logger } from "./utils/Logger";
type DatabaseArgs<Schema extends AnySchema, Relations extends RuntimeRelationsDefinition<Schema>> = {
    schema?: RuntimeSchemaDefinition<Schema>;
    relations?: Relations;
    storage?: StorageApi;
    logger: Logger;
    rng: RngApi;
};
export declare class Database<Schema extends AnySchema, Relations extends RuntimeRelationsDefinition<Schema> = RuntimeRelationsDefinition<Schema>> {
    private readonly tupleDb;
    private readonly storage?;
    private readonly logger;
    private readonly rng;
    readonly schema?: RuntimeSchemaDefinition<Schema>;
    readonly relations?: Relations;
    private storageWriteQueue?;
    readonly ready: Promise<void>;
    constructor({ logger, schema, relations, storage: storageAdapter, rng, }: DatabaseArgs<Schema, Relations>);
    clear(): Promise<void>;
    /**
     * What if values in storage changes?
     * What if storage too big to load all at once?
     */
    private loadFromStorage;
    /**
     * Flush any pending writes to storage immediately.
     */
    flushStorage(): Promise<void>;
    makeTupleDbTransaction(): TupleRootTransactionApi;
    transact(): Transaction<Schema>;
    commit(transaction: Transaction<Schema>): void;
    subscribe<Query extends RelationalQuery<Schema, Relations>>(query: Query, callback: (result: RelationalQueryResult<Schema, Relations, Query>) => void): {
        result: RelationalQueryResult<Schema, Relations, Query>;
        destroy: () => void;
    };
    query<Query extends RelationalQuery<Schema, Relations>>(query: Query): RelationalQueryResult<Schema, Relations, Query>;
    private runRelationalQuery;
    private getRelationalRows;
    private matchesRelationalWhere;
    private compareRelationalValue;
    private expandRelationalRow;
}
export {};
//# sourceMappingURL=Database.d.ts.map