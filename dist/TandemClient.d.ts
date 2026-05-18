import { Transaction } from "./transaction/Transaction.js";
import { AnySchema, ClientId, RemoteApi, RelationalQuery, RelationalQueryResult, RngApi, RuntimeRelationsDefinition, RuntimeSchemaDefinition, StorageApi, type TimerApi } from "./types.js";
import { Logger } from "./utils/Logger.js";
type TandemClientArgs<Schema extends AnySchema, Relations extends RuntimeRelationsDefinition<Schema>> = {
    schema?: RuntimeSchemaDefinition<Schema>;
    relations?: Relations;
    storage?: StorageApi;
    remote?: RemoteApi<Schema>;
    logger?: Logger;
    rng?: RngApi;
    timer?: TimerApi;
    autoConnect?: boolean;
    /**
     * @default 150
     */
    syncInterval?: number;
};
export declare class TandemClient<Schema extends AnySchema, Relations extends RuntimeRelationsDefinition<Schema> = RuntimeRelationsDefinition<Schema>> {
    private readonly db;
    /**
     * Resolves when initial load from storage completes
     */
    readonly ready: Promise<void>;
    readonly clientId: ClientId;
    private readonly syncEngine?;
    private readonly logger;
    private readonly rng;
    private speculativeMutations;
    constructor({ schema, relations, storage: storageAdapter, remote, logger, autoConnect, syncInterval, rng, timer, }: TandemClientArgs<Schema, Relations>);
    pullFromRemote(): Promise<void>;
    private applyPatchAt;
    private rollback;
    query<Query extends RelationalQuery<Schema, Relations>>(query: Query): RelationalQueryResult<Schema, Relations, Query>;
    subscribe<Query extends RelationalQuery<Schema, Relations>>(query: Query, callback: (result: RelationalQueryResult<Schema, Relations, Query>) => void): {
        result: RelationalQueryResult<Schema, Relations, Query>;
        destroy: () => void;
    };
    transact(): Transaction<Schema>;
    commit(transaction: Transaction<Schema>): Promise<void>;
    connect(): Promise<import("./index.js").AsyncUnsubscribe>;
    disconnect(): Promise<void>;
    /**
     * Flush any pending writes to storage immediately.
     */
    flushStorage(): Promise<void>;
    clear(): Promise<void>;
}
export {};
//# sourceMappingURL=TandemClient.d.ts.map