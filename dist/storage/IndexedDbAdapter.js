/// <reference lib="dom" />
import { deleteDB, openDB } from "idb";
import { decodeTuple, encodeTuple } from "tuple-database/helpers/codec.js";
const version = 1;
const storeName = "tupledb";
function getSchemaCodecs(schema) {
    if (!schema)
        return undefined;
    return Object.fromEntries(Object.entries(schema.collections)
        .filter(([, collection]) => collection.codec)
        .map(([name, collection]) => [name, collection.codec]));
}
export class IndexedDbTupleStorage {
    db;
    codecs;
    dbName;
    constructor({ dbName, schema, codecs, }) {
        this.codecs = {
            ...getSchemaCodecs(schema),
            ...codecs,
        };
        this.dbName = dbName;
        this.db = openDB(dbName, version, {
            upgrade(db) {
                db.createObjectStore(storeName);
            },
        });
    }
    async scan(args) {
        const db = await this.db;
        const tx = db.transaction(storeName, "readonly");
        const index = tx.store; // primary key
        const lower = args?.gt || args?.gte;
        const lowerEq = Boolean(args?.gte);
        const upper = args?.lt || args?.lte;
        const upperEq = Boolean(args?.lte);
        let range;
        if (upper) {
            if (lower) {
                range = IDBKeyRange.bound(encodeTuple(lower), encodeTuple(upper), !lowerEq, !upperEq);
            }
            else {
                range = IDBKeyRange.upperBound(encodeTuple(upper), !upperEq);
            }
        }
        else {
            if (lower) {
                range = IDBKeyRange.lowerBound(encodeTuple(lower), !lowerEq);
            }
            else {
                range = null;
            }
        }
        const direction = args?.reverse ? "prev" : "next";
        const limit = args?.limit || Infinity;
        let results = [];
        for await (const cursor of index.iterate(range, direction)) {
            const key = decodeTuple(cursor.key);
            const recordType = key[1];
            const codec = this.codecs?.[recordType];
            const value = codec ? codec.decode(cursor.value) : cursor.value;
            results.push({
                key,
                value,
            });
            if (results.length >= limit)
                break;
        }
        await tx.done;
        return results;
    }
    async commit(writes) {
        const db = await this.db;
        const tx = db.transaction(storeName, "readwrite");
        for (const { key, value } of writes.set || []) {
            const recordType = key[1];
            const codec = this.codecs?.[recordType];
            const encodedValue = codec ? codec.encode(value) : value;
            await tx.store.put(encodedValue, encodeTuple(key));
        }
        for (const key of writes.remove || []) {
            await tx.store.delete(encodeTuple(key));
        }
        await tx.done;
    }
    async close() {
        const db = await this.db;
        db.close();
    }
    async clear() {
        const db = await this.db;
        db.close();
        // Delete the database using idb's deleteDB
        await deleteDB(this.dbName);
        // Recreate the database
        this.db = openDB(this.dbName, version, {
            upgrade(db) {
                db.createObjectStore(storeName);
            },
        });
    }
}
//# sourceMappingURL=IndexedDbAdapter.js.map