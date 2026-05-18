import { Database } from "./Database";
import { _encodeRelationalQuery } from "./query/Query";
import { SyncEngine } from "./sync/SyncEngine";
import { MutationApi, PatchApi, } from "./types";
import { ConsoleLoggerSink, Logger } from "./utils/Logger";
import { randomId } from "./utils/randomId";
import { Timer } from "./utils/Timer";
export class TandemClient {
    db;
    /**
     * Resolves when initial load from storage completes
     */
    ready;
    // TODO: use a real uuid
    clientId;
    syncEngine;
    logger;
    rng;
    speculativeMutations = [];
    constructor({ schema, relations, storage: storageAdapter, remote, logger, autoConnect = true, syncInterval = 150, rng, timer, }) {
        this.rng = rng ?? { randomId };
        this.clientId = this.rng.randomId();
        this.logger = logger ?? new Logger({ sinks: new ConsoleLoggerSink() });
        const timerImpl = timer ?? new Timer();
        this.syncEngine = remote
            ? new SyncEngine({
                remote,
                clientId: this.clientId,
                handleRollback: (mutationsToRollback) => {
                    this.rollback(mutationsToRollback);
                },
                applyPatchAt: (args) => this.applyPatchAt(args),
                autoConnect,
                logger: this.logger.scope("sync-engine"),
                syncInterval,
                timer: timerImpl,
            })
            : undefined;
        this.db = new Database({
            schema,
            relations,
            logger: this.logger.scope("db"),
            storage: storageAdapter,
            rng: this.rng,
        });
        this.ready = this.db.ready;
    }
    pullFromRemote() {
        if (!this.syncEngine) {
            return Promise.resolve();
        }
        this.logger.info({ message: "pulling from remote" });
        return this.syncEngine.queuePull();
    }
    applyPatchAt({ patch, lastMutationId, }) {
        this.logger.info({ message: "applying patch" });
        if (patch.set?.length === 0 && patch.remove?.length === 0) {
            this.logger.info({ message: "no ops to apply" });
            return;
        }
        // A little magick-y but this works as expected even when lastMutationId is
        // undefined because this will be -1, and we'll report all speculative mutations
        // as still speculative
        const commitedMutationIndex = this.speculativeMutations.findIndex((m) => m.id === lastMutationId);
        const tx = this.db.makeTupleDbTransaction();
        // Rollback to before all the speculative mutations
        const inverted = MutationApi.getRollbackWrites(this.speculativeMutations);
        tx.write(inverted);
        // Convert patch to WriteOps and apply
        const writeOps = PatchApi.toWriteOps(patch);
        tx.write(writeOps);
        // Apply the un-committed still speculative mutations on top
        const stillSpeculative = this.speculativeMutations.slice(commitedMutationIndex + 1);
        for (const mutation of stillSpeculative) {
            tx.write(MutationApi.toWriteOps(mutation.ops));
        }
        tx.commit();
        this.speculativeMutations = stillSpeculative;
    }
    rollback(mutationsToRollback) {
        this.logger.info({ message: "rolling back" });
        const inverted = MutationApi.getRollbackWrites(mutationsToRollback);
        const tx = this.db.makeTupleDbTransaction();
        tx.write(inverted);
        tx.commit();
    }
    query(query) {
        return this.db.query(query);
    }
    subscribe(query, callback) {
        const { result, destroy } = this.db.subscribe(query, callback);
        const unsubscribe = this.syncEngine?.subscribe(_encodeRelationalQuery(query.collection, query, this.db.relations));
        return {
            result,
            destroy: () => {
                unsubscribe?.();
                destroy();
            },
        };
    }
    transact() {
        return this.db.transact();
    }
    commit(transaction) {
        if (transaction.ops.length === 0) {
            this.logger.info({
                message: "attempted to commit transaction with no ops",
            });
            return Promise.resolve();
        }
        this.logger.info({ message: "committing transaction" });
        const mutation = {
            ops: transaction.ops,
            id: transaction.tupleDbTx.id,
        };
        this.db.commit(transaction);
        this.speculativeMutations.push(mutation);
        const commitPromise = this.syncEngine?.queuePush(mutation) ?? Promise.resolve();
        // Ignored commit promises should not surface unhandled rejections.
        commitPromise.catch(() => { });
        return commitPromise;
    }
    async connect() {
        if (!this.syncEngine) {
            throw new Error("Attempted to connect without a remote server configured");
        }
        return await this.syncEngine.connect();
    }
    async disconnect() {
        if (!this.syncEngine) {
            this.logger.warn({
                message: "attempted to disconnect without a remote server configured",
            });
            return;
        }
        return await this.syncEngine.disconnect();
    }
    /**
     * Flush any pending writes to storage immediately.
     */
    async flushStorage() {
        await this.db.flushStorage();
    }
    async clear() {
        this.logger.info({ message: "clearing database" });
        // Clear speculative mutations
        this.speculativeMutations = [];
        // Clear the database
        await this.db.clear();
    }
}
//# sourceMappingURL=TandemClient.js.map