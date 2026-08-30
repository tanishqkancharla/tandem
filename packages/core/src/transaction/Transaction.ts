import type { TupleRootTransactionApi } from "tuple-database"
import {
	AnySchema,
	CollectionName,
	InvertibleMutationOp,
	SchemaToTupleSchema,
} from "@get-halo/tandem-types"

export class Transaction<Schema extends AnySchema> {
	/**
	 * @internal
	 */
	readonly ops: InvertibleMutationOp<Schema>[] = []

	constructor(
		/**
		 * @internal
		 */
		readonly tupleDbTx: TupleRootTransactionApi,
	) {}

	list<Collection extends CollectionName<Schema>>(
		collection: Collection,
	): Readonly<Schema[Collection]>[] {
		const results = this.tupleDbTx.scan({
			gte: ["record", collection, null],
			lte: ["record", collection, true],
		})

		return results.map((result) => result.value)
	}

	get<Collection extends CollectionName<Schema>>(
		collection: Collection,
		id: Schema[Collection]["id"],
	): Readonly<Schema[Collection]> | undefined {
		const tupleSchemaKey: SchemaToTupleSchema<Schema>["key"] = [
			"record",
			collection,
			id,
		]

		const result = this.tupleDbTx.scan({
			gte: tupleSchemaKey,
			lte: tupleSchemaKey,
		})

		const first = result[0]

		if (!first) {
			return undefined
		}

		return first.value
	}

	set<Collection extends CollectionName<Schema>>(
		collection: Collection,
		record: Schema[Collection],
	): Transaction<Schema> {
		const tupleSchema: SchemaToTupleSchema<Schema> = {
			key: ["record", collection, record.id],
			value: record,
		}

		const prevValueResult = this.tupleDbTx.scan({
			gte: tupleSchema.key,
			lte: tupleSchema.key,
		})

		this.tupleDbTx.set<any>(tupleSchema.key, tupleSchema.value)

		const setOp: InvertibleMutationOp<Schema> = {
			type: "set",
			collection,
			value: tupleSchema.value,
		}

		if (prevValueResult.length > 0) {
			setOp.prevValue = prevValueResult[0]!.value
		}

		this.ops.push(setOp)

		return this
	}

	/**
	 * Updates a record in the database with the given updater function *only if
	 * the record exists*.
	 */
	update<Collection extends CollectionName<Schema>>(
		collection: Collection,
		id: Schema[Collection]["id"],
		updateFn: (record: Readonly<Schema[Collection]>) => Schema[Collection],
	): Transaction<Schema> {
		const tupleSchemaKey: SchemaToTupleSchema<Schema>["key"] = [
			"record",
			collection,
			id,
		]

		const prevValueResult = this.tupleDbTx.scan({
			gte: tupleSchemaKey,
			lte: tupleSchemaKey,
		})

		if (prevValueResult.length === 0) {
			return this
		}

		const prevRecord = prevValueResult[0]!.value

		const updatedRecord = updateFn(prevRecord)
		if (updatedRecord === prevRecord) {
			return this
		}

		this.tupleDbTx.set<any>(tupleSchemaKey, updatedRecord)

		const setOp: InvertibleMutationOp<Schema> = {
			type: "set",
			collection,
			value: updatedRecord,
		}

		setOp.prevValue = prevRecord

		this.ops.push(setOp)

		return this
	}

	remove<Collection extends CollectionName<Schema>>(
		collection: Collection,
		id: Schema[Collection]["id"],
	): Transaction<Schema> {
		const tupleSchemaKey: SchemaToTupleSchema<Schema>["key"] = [
			"record",
			collection,
			id,
		]

		const values = this.tupleDbTx.scan({
			gte: tupleSchemaKey,
			lte: tupleSchemaKey,
		})

		this.tupleDbTx.remove(tupleSchemaKey)

		if (values.length) {
			this.ops.push({
				type: "remove",
				collection,
				id,
				value: values[0]!.value,
			})
		}

		return this
	}

	cancel() {
		this.tupleDbTx.cancel()
	}
}
