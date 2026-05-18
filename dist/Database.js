import { InMemoryTupleStorage, subscribeQuery, TupleDatabase, TupleDatabaseClient, } from "tuple-database";
import { Storage } from "./storage/Storage";
import { Transaction } from "./transaction/Transaction";
import { WriteOpsApi, } from "./types";
import { isEqual, pick, sortBy } from "./utils/objectUtils";
import { ThrottleQueue } from "./utils/ThrottleQueue";
import { Timer } from "./utils/Timer";
export class Database {
    tupleDb = new TupleDatabaseClient(new TupleDatabase(new InMemoryTupleStorage()));
    storage;
    logger;
    rng;
    schema;
    relations;
    storageWriteQueue;
    ready;
    constructor({ logger, schema, relations, storage: storageAdapter, rng, }) {
        this.logger = logger;
        this.schema = schema;
        this.relations = relations;
        this.storage = storageAdapter
            ? new Storage(storageAdapter, (error) => {
                // TODO: clean up? What should we do when storage fails?
                this.logger.error({ message: "storage error", error });
            })
            : undefined;
        this.rng = rng;
        this.ready = this.storage
            ? this.loadFromStorage(this.storage)
            : Promise.resolve();
    }
    async clear() {
        // Clear the in-memory tuple database
        const writeOps = this.tupleDb.scan({}).reduce((ops, { key }) => {
            ops.remove = ops.remove || [];
            ops.remove.push(key);
            return ops;
        }, {});
        if (writeOps.remove?.length) {
            this.tupleDb.commit(writeOps);
        }
        // Clear storage if available
        await this.storage?.clear();
    }
    /**
     * What if values in storage changes?
     * What if storage too big to load all at once?
     */
    async loadFromStorage(storage) {
        this.logger.info({ message: "loading from storage" });
        const results = await storage.scan();
        this.tupleDb.commit({ set: results });
        let writeOpsQueue = {};
        const storageWriteQueue = new ThrottleQueue(async () => {
            this.logger.info({ message: "committing to storage" });
            const copy = writeOpsQueue;
            writeOpsQueue = {};
            try {
                await storage.commit(copy);
                this.logger.info({ message: "committed to storage" });
            }
            catch (error) {
                this.logger.error({ message: "error committing to storage", error });
                writeOpsQueue = copy;
            }
        }, 120, new Timer());
        this.storageWriteQueue = storageWriteQueue;
        this.tupleDb.subscribe({}, (writeOps) => {
            writeOpsQueue = WriteOpsApi.merge(writeOpsQueue, writeOps);
            void storageWriteQueue.enqueue();
        });
    }
    /**
     * Flush any pending writes to storage immediately.
     */
    async flushStorage() {
        await this.storageWriteQueue?.flush();
    }
    makeTupleDbTransaction() {
        return this.tupleDb.transact(this.rng.randomId());
    }
    transact() {
        const tupleDbTx = this.tupleDb.transact(this.rng.randomId());
        return new Transaction(tupleDbTx);
    }
    commit(transaction) {
        transaction.tupleDbTx.commit();
    }
    subscribe(query, callback) {
        return subscribeQuery(this.tupleDb, (db) => this.runRelationalQuery(query.collection, query, undefined, db), callback);
    }
    query(query) {
        return this.runRelationalQuery(query.collection, query);
    }
    runRelationalQuery(collection, options, extraFilter, tupleDb = this.tupleDb) {
        const rows = this.getRelationalRows(collection, options, extraFilter, tupleDb);
        return rows.map((row) => this.expandRelationalRow(collection, row, options, tupleDb));
    }
    getRelationalRows(collection, options, extraFilter, tupleDb = this.tupleDb) {
        let results = tupleDb
            .scan({
            gte: ["record", collection, null],
            lte: ["record", collection, true],
        })
            .map(({ value }) => value);
        if (extraFilter) {
            results = results.filter(extraFilter);
        }
        if (options.where) {
            results = results.filter((record) => Object.entries(options.where ?? {}).every(([field, condition]) => this.matchesRelationalWhere(record, field, condition)));
        }
        if (options.orderBy) {
            results = sortBy(results, ...Object.entries(options.orderBy).flatMap(([field, direction]) => direction ? [[(item) => item[field], direction]] : []));
        }
        if (options.offset !== undefined) {
            results = results.slice(options.offset);
        }
        if (options.limit !== undefined) {
            results = results.slice(0, options.limit);
        }
        return results;
    }
    matchesRelationalWhere(record, field, condition) {
        const fieldValue = record[field];
        if (typeof condition === "object" &&
            condition !== null &&
            !Array.isArray(condition)) {
            return Object.entries(condition).every(([operator, value]) => this.compareRelationalValue(fieldValue, operator, value));
        }
        return isEqual(fieldValue, condition);
    }
    compareRelationalValue(fieldValue, operator, comparisonValue) {
        switch (operator) {
            case "eq":
                return isEqual(fieldValue, comparisonValue);
            case "gt":
                return fieldValue > comparisonValue;
            case "lt":
                return fieldValue < comparisonValue;
            case "gte":
                return fieldValue >= comparisonValue;
            case "lte":
                return fieldValue <= comparisonValue;
            default:
                throw new Error(`Unknown where operator "${operator}"`);
        }
    }
    expandRelationalRow(collection, row, options, tupleDb = this.tupleDb) {
        const result = options.select
            ? pick(row, Object.keys(options.select))
            : { ...row };
        if (!options.with)
            return result;
        if (!this.relations) {
            throw new Error("Cannot execute relational query includes without relations");
        }
        for (const [relationName, includeOptions] of Object.entries(options.with)) {
            const relation = this.relations[collection]?.[relationName];
            if (!relation) {
                throw new Error(`Unknown relation "${collection}.${relationName}"`);
            }
            const targetCollection = relation.targetCollection;
            const nestedOptions = includeOptions === true ? {} : includeOptions;
            if (relation.type === "many-to-one") {
                const joinValue = row[relation.from];
                result[relationName] =
                    this.runRelationalQuery(targetCollection, nestedOptions, (target) => target[relation.to] === joinValue, tupleDb)[0] ?? null;
            }
            else {
                const joinValue = row[relation.from];
                result[relationName] = this.runRelationalQuery(targetCollection, nestedOptions, (target) => target[relation.to] === joinValue, tupleDb);
            }
        }
        return result;
    }
}
//# sourceMappingURL=Database.js.map