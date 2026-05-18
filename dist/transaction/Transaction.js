export class Transaction {
    tupleDbTx;
    /**
     * @internal
     */
    ops = [];
    constructor(
    /**
     * @internal
     */
    tupleDbTx) {
        this.tupleDbTx = tupleDbTx;
    }
    list(collection) {
        const results = this.tupleDbTx.scan({
            gte: ["record", collection, null],
            lte: ["record", collection, true],
        });
        return results.map((result) => result.value);
    }
    get(collection, id) {
        const tupleSchemaKey = [
            "record",
            collection,
            id,
        ];
        const result = this.tupleDbTx.scan({
            gte: tupleSchemaKey,
            lte: tupleSchemaKey,
        });
        const first = result[0];
        if (!first) {
            return undefined;
        }
        return first.value;
    }
    set(collection, record) {
        const tupleSchema = {
            key: ["record", collection, record.id],
            value: record,
        };
        const prevValueResult = this.tupleDbTx.scan({
            gte: tupleSchema.key,
            lte: tupleSchema.key,
        });
        this.tupleDbTx.set(tupleSchema.key, tupleSchema.value);
        const setOp = {
            type: "set",
            collection,
            value: tupleSchema.value,
        };
        if (prevValueResult.length > 0) {
            setOp.prevValue = prevValueResult[0].value;
        }
        this.ops.push(setOp);
        return this;
    }
    /**
     * Updates a record in the database with the given updater function *only if
     * the record exists*.
     */
    update(collection, id, updateFn) {
        const tupleSchemaKey = [
            "record",
            collection,
            id,
        ];
        const prevValueResult = this.tupleDbTx.scan({
            gte: tupleSchemaKey,
            lte: tupleSchemaKey,
        });
        if (prevValueResult.length === 0) {
            return this;
        }
        const prevRecord = prevValueResult[0].value;
        const updatedRecord = updateFn(prevRecord);
        if (updatedRecord === prevRecord) {
            return this;
        }
        this.tupleDbTx.set(tupleSchemaKey, updatedRecord);
        const setOp = {
            type: "set",
            collection,
            value: updatedRecord,
        };
        setOp.prevValue = prevRecord;
        this.ops.push(setOp);
        return this;
    }
    remove(collection, id) {
        const tupleSchemaKey = [
            "record",
            collection,
            id,
        ];
        const values = this.tupleDbTx.scan({
            gte: tupleSchemaKey,
            lte: tupleSchemaKey,
        });
        this.tupleDbTx.remove(tupleSchemaKey);
        if (values.length) {
            this.ops.push({
                type: "remove",
                collection,
                id,
                value: values[0].value,
            });
        }
        return this;
    }
    cancel() {
        this.tupleDbTx.cancel();
    }
}
//# sourceMappingURL=Transaction.js.map