import type { KeyValuePair, ScanStorageArgs, WriteOps } from "tuple-database";
import type { StorageApi } from "../types";
export declare class Storage {
    readonly adapter: StorageApi;
    private readonly onFailure;
    constructor(adapter: StorageApi, onFailure: (error: unknown) => void);
    commit(writeOps: WriteOps): Promise<void>;
    scan(args?: ScanStorageArgs): Promise<KeyValuePair[]>;
    clear(): Promise<void>;
}
//# sourceMappingURL=Storage.d.ts.map