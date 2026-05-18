import { KeyValuePair, ScanStorageArgs, WriteOps } from "tuple-database";
import { AnySchema, Json, RuntimeSchemaDefinition, StorageApi } from "../types.js";
import { Codec } from "../utils/Codec.js";
type AnyStorageSchema<Schema extends AnySchema> = {
    [K in keyof Schema]?: Json;
};
type IndexedDbTupleStorageArgs<Schema extends AnySchema, StorageSchema extends AnyStorageSchema<Schema> = AnyStorageSchema<Schema>> = {
    dbName: string;
    schema?: RuntimeSchemaDefinition<Schema>;
    codecs?: {
        [K in keyof Schema]?: Codec<Schema[K], StorageSchema[K]>;
    };
};
export declare class IndexedDbTupleStorage<Schema extends AnySchema, StorageSchema extends {
    [K in keyof Schema]?: Json;
} = Schema> implements StorageApi {
    private db;
    private codecs?;
    private dbName;
    constructor({ dbName, schema, codecs, }: IndexedDbTupleStorageArgs<Schema, StorageSchema>);
    scan(args?: ScanStorageArgs): Promise<KeyValuePair[]>;
    commit(writes: WriteOps): Promise<void>;
    close(): Promise<void>;
    clear(): Promise<void>;
}
export {};
//# sourceMappingURL=IndexedDbAdapter.d.ts.map