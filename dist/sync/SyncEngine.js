import { PatchApi, } from "../types";
import { TaskQueue } from "../utils/TaskQueue.js";
function invertibleMutationToMutation(invertible) {
    return {
        id: invertible.id,
        ops: invertible.ops.map((op) => {
            if (op.type === "set") {
                return {
                    type: "set",
                    collection: op.collection,
                    value: op.value,
                };
            }
            else if (op.type === "remove") {
                return {
                    type: "remove",
                    collection: op.collection,
                    id: op.id,
                };
            }
            return op;
        }),
    };
}
export class SyncEngine {
    syncQueue;
    pendingMutations = [];
    remote;
    logger;
    handleRollback;
    applyPatchAt;
    clientId;
    cookie;
    disconnectFromRemote;
    scanWindow = [];
    constructor(args) {
        this.logger = args.logger;
        this.remote = args.remote;
        this.handleRollback = args.handleRollback;
        this.applyPatchAt = args.applyPatchAt;
        this.clientId = args.clientId;
        this.syncQueue = new TaskQueue({
            pull: () => this.pull(),
            push: () => this.push(),
        }, args.syncInterval, args.timer);
        if (args.autoConnect) {
            this.connect().catch((error) => {
                // TODO: disconnect and operate in offline mode
                this.logger.error({ message: "error connecting to remote", error });
            });
        }
    }
    async connect() {
        this.logger.info({ message: "connecting to remote" });
        const unsubscribe = await this.remote.connect({
            clientId: this.clientId,
            poke: () => {
                this.logger.info({ message: "received poke from remote" });
                void this.queuePull().catch((error) => {
                    this.logger.error({ message: "error pulling from remote", error });
                });
            },
        });
        this.disconnectFromRemote = unsubscribe;
        this.logger.info({ message: "connected to remote" });
        await this.queuePull();
        if (this.pendingMutations.length > 0) {
            await this.syncQueue.enqueue("push");
        }
        return unsubscribe;
    }
    async disconnect() {
        this.logger.info({ message: "disconnecting from remote" });
        await this.disconnectFromRemote?.();
        this.disconnectFromRemote = undefined;
    }
    subscribe(query) {
        this.logger.info({ message: "subscribing to query", query });
        this.scanWindow.push(query);
        void this.queuePull().catch((error) => {
            this.logger.error({ message: "error pulling from remote", error });
        });
        return () => {
            this.logger.info({ message: "unsubscribing from query", query });
            this.scanWindow.splice(this.scanWindow.indexOf(query), 1);
        };
    }
    queuePull() {
        this.logger.info({ message: "queueing pull" });
        return this.syncQueue.enqueue("pull").then(() => {
            this.logger.info({ message: "pull finished" });
        });
    }
    async pull() {
        if (!this.disconnectFromRemote) {
            return;
        }
        this.logger.info({ message: "pulling from remote" });
        const { cookie, patch, lastMutationId } = await this.remote.pull({
            clientId: this.clientId,
            cookie: this.cookie,
            scanWindow: this.scanWindow,
        });
        this.logger.info({
            message: "pulled from remote",
            cookie,
            lastMutationId,
            patch: PatchApi.toString(patch),
        });
        this.cookie = cookie;
        this.applyPatchAt({ patch, lastMutationId });
    }
    queuePush(mutation) {
        this.logger.info({ message: "queueing push" });
        this.pendingMutations.push(mutation);
        return this.syncQueue.enqueue("push");
    }
    async push() {
        if (this.pendingMutations.length === 0)
            return;
        if (!this.disconnectFromRemote) {
            this.logger.info({ message: "skipping push while disconnected" });
            return;
        }
        const mutations = this.pendingMutations;
        this.pendingMutations = [];
        try {
            // Convert invertible mutations to regular mutations before pushing
            const serializedMutations = mutations.map(invertibleMutationToMutation);
            // Then apply to remote if available
            await this.remote.push({
                mutations: serializedMutations,
                clientId: this.clientId,
            });
        }
        catch (error) {
            this.logger.error({ message: "error applying mutation", error });
            this.handleRollback(mutations);
            throw error;
        }
    }
}
//# sourceMappingURL=SyncEngine.js.map