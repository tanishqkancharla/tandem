import type { TupleRootTransactionApi } from "tuple-database";
import { AnySchema, CollectionName, InvertibleMutationOp } from "../types";
export declare class Transaction<Schema extends AnySchema> {
    /**
     * @internal
     */
    readonly tupleDbTx: TupleRootTransactionApi;
    /**
     * @internal
     */
    readonly ops: InvertibleMutationOp<Schema>[];
    constructor(
    /**
     * @internal
     */
    tupleDbTx: TupleRootTransactionApi);
    list<Collection extends CollectionName<Schema>>(collection: Collection): Readonly<Schema[Collection]>[];
    get<Collection extends CollectionName<Schema>>(collection: Collection, id: Schema[Collection]["id"]): Readonly<Schema[Collection]> | undefined;
    set<Collection extends CollectionName<Schema>>(collection: Collection, record: Schema[Collection]): Transaction<Schema>;
    /**
     * Updates a record in the database with the given updater function *only if
     * the record exists*.
     */
    update<Collection extends CollectionName<Schema>>(collection: Collection, id: Schema[Collection]["id"], updateFn: (record: Readonly<Schema[Collection]>) => Schema[Collection]): Transaction<Schema>;
    remove<Collection extends CollectionName<Schema>>(collection: Collection, id: Schema[Collection]["id"]): Transaction<Schema>;
    cancel(): void;
}
//# sourceMappingURL=Transaction.d.ts.map