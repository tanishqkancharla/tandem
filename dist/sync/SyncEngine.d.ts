import { type AnySchema, type ClientId, type EncodedQuery, type InvertibleMutation, type TimerApi } from "../types";
import type { AsyncUnsubscribe, Unsubscribe } from "../utils/typeUtils.js";
type SyncEngineArgs<Schema extends AnySchema> = {
    clientId: ClientId;
    remote: SyncEngine<Schema>["remote"];
    handleRollback: SyncEngine<Schema>["handleRollback"];
    applyPatchAt: SyncEngine<Schema>["applyPatchAt"];
    autoConnect?: boolean;
    syncInterval: number;
    logger: SyncEngine<Schema>["logger"];
    timer: TimerApi;
};
export declare class SyncEngine<Schema extends AnySchema> {
    private syncQueue;
    private pendingMutations;
    private readonly remote;
    private readonly logger;
    private readonly handleRollback;
    private readonly applyPatchAt;
    private readonly clientId;
    private cookie?;
    private disconnectFromRemote?;
    private scanWindow;
    constructor(args: SyncEngineArgs<Schema>);
    connect(): Promise<AsyncUnsubscribe>;
    disconnect(): Promise<void>;
    subscribe(query: EncodedQuery<Schema>): Unsubscribe;
    queuePull(): Promise<void>;
    private pull;
    queuePush(mutation: InvertibleMutation<Schema>): Promise<void>;
    private push;
}
export {};
//# sourceMappingURL=SyncEngine.d.ts.map