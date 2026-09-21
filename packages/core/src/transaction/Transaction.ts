import type { TupleRootTransactionApi, WriteOps } from "tuple-database"
import type {
	AnySchema,
	CollectionIdTuple,
	CollectionName,
	CollectionScanArgs,
	SchemaToTupleSchema,
} from "../schema/Schema"
import { collectionIdToTuple } from "../schema/Schema"
import type { EncodedQuery, ScanWindow } from "../query/Query"
import { WriteOpsApi } from "../clientStorage/TandemClientStorage"
import { partition, reverse } from "../utils/objectUtils"
import type { Tagged } from "../utils/typeUtils"

type CollectionTupleKey<
	Schema extends AnySchema,
	Collection extends CollectionName<Schema>,
> = CollectionIdTuple<Schema[Collection]["id"]>

type CollectionTransactionApi<
	Schema extends AnySchema,
	Collection extends CollectionName<Schema>,
> = {
	scan(args?: CollectionScanArgs<Schema[Collection]["id"]>): {
		key: CollectionTupleKey<Schema, Collection>
		value: Schema[Collection]
	}[]
	get(
		key: CollectionTupleKey<Schema, Collection>,
	): Schema[Collection] | undefined
	set(
		key: CollectionTupleKey<Schema, Collection>,
		value: Schema[Collection],
	): unknown
	remove(key: CollectionTupleKey<Schema, Collection>): unknown
}

function getCollectionTransaction<
	Schema extends AnySchema,
	Collection extends CollectionName<Schema>,
>(
	transaction: TupleRootTransactionApi<SchemaToTupleSchema<Schema>>,
	collection: Collection,
): CollectionTransactionApi<Schema, Collection> {
	// tuple-database's key filtering cannot reduce a mapped tuple union while
	// Schema is generic. Narrow the transaction once per selected collection.
	const collectionRoot = transaction as unknown as {
		subspace(
			prefix: ["record", Collection],
		): CollectionTransactionApi<Schema, Collection>
	}
	return collectionRoot.subspace(["record", collection])
}

export type InveribleSetMutationOp<Schema extends AnySchema> = {
	type: "set"
} & {
	[Collection in CollectionName<Schema>]: {
		collection: Collection
		value: Schema[Collection]
		prevValue?: Schema[Collection]
	}
}[CollectionName<Schema>]

export type InveribleRemoveMutationOp<Schema extends AnySchema> = {
	type: "remove"
} & {
	[Collection in CollectionName<Schema>]: {
		collection: Collection
		id: Schema[Collection]["id"]
		value: Schema[Collection]
	}
}[CollectionName<Schema>]

export type SetMutationOp<Schema extends AnySchema> = {
	type: "set"
} & {
	[Collection in CollectionName<Schema>]: {
		collection: Collection
		value: Schema[Collection]
	}
}[CollectionName<Schema>]

export type RemoveMutationOp<Schema extends AnySchema> = {
	type: "remove"
} & {
	[Collection in CollectionName<Schema>]: {
		collection: Collection
		id: Schema[Collection]["id"]
	}
}[CollectionName<Schema>]

export type InvertibleMutationOp<Schema extends AnySchema> =
	| InveribleSetMutationOp<Schema>
	| InveribleRemoveMutationOp<Schema>
export type MutationOp<Schema extends AnySchema> =
	| SetMutationOp<Schema>
	| RemoveMutationOp<Schema>

export type MutationId = Tagged<"MutationId", string>
export type Mutation<Schema extends AnySchema> = {
	ops: MutationOp<Schema>[]
	id: MutationId
}
export type InvertibleMutation<Schema extends AnySchema> = {
	ops: InvertibleMutationOp<Schema>[]
	id: MutationId
}

export namespace MutationApi {
	function invertMutationOp<Schema extends AnySchema = AnySchema>(
		op: InvertibleMutationOp<Schema>,
	): MutationOp<Schema> {
		switch (op.type) {
			case "set": {
				return "prevValue" in op
					? {
							type: "set",
							collection: op.collection,
							value: op.prevValue as Schema[CollectionName<Schema>],
						}
					: {
							type: "remove",
							collection: op.collection,
							id: op.value.id,
						}
			}
			case "remove": {
				return {
					type: "set",
					collection: op.collection,
					value: op.value,
				}
			}
			default:
				throw new Error("Unknown mutation op type")
		}
	}

	export function getRollbackWrites<Schema extends AnySchema>(
		mutations: readonly InvertibleMutation<Schema>[],
	): WriteOps<SchemaToTupleSchema<Schema>> {
		return WriteOpsApi.merge(
			...reverse(mutations)
				.map((mutation) => mutation.ops.map(invertMutationOp))
				.map(toWriteOps),
		)
	}

	export function toWriteOps<Schema extends AnySchema>(
		ops: MutationOp<Schema>[],
	): WriteOps<SchemaToTupleSchema<Schema>> {
		const [setOps, removeOps] = partition(ops, (op) => op.type === "set")

		const writeOps: WriteOps<SchemaToTupleSchema<Schema>> = {
			set: setOps.map((op) => ({
				key: ["record", op.collection, ...collectionIdToTuple(op.value.id)],
				value: op.value,
			})) as unknown as SchemaToTupleSchema<Schema>[],
			remove: removeOps.map((op) => [
				"record",
				op.collection,
				...collectionIdToTuple(op.id),
			]),
		}

		return writeOps
	}

	function opToDebugString(op: MutationOp<AnySchema>): string {
		switch (op.type) {
			case "set":
				return `set (${op.collection}) ${JSON.stringify(
					op.value,
					undefined,
					2,
				)}`
			case "remove":
				return `remove (${op.collection}) ${op.id}`
		}
	}

	export function toString<Schema extends AnySchema>(
		mutation: Mutation<Schema>,
	): string {
		return `Mutation {\n${mutation.ops
			.map(opToDebugString)
			.map((s) => `  ${s}`)
			.join("\n")}\n}`
	}

	export function intersectsQuery<Schema extends AnySchema>(
		mutation: Mutation<Schema>,
		query: EncodedQuery<Schema>,
	): boolean {
		for (const op of mutation.ops) {
			const { collection } = query
			if (op.collection !== collection) continue

			// TODO: use select and where
			return true
		}

		return Object.values(query.with ?? {}).some((includedQuery) =>
			intersectsQuery(mutation, includedQuery),
		)
	}

	export function intersectsScanWindow<Schema extends AnySchema>(
		mutation: Mutation<Schema>,
		scanWindow: ScanWindow<Schema>,
	): boolean {
		return scanWindow.some((query) => intersectsQuery(mutation, query))
	}
}

export class Transaction<Schema extends AnySchema> {
	/**
	 * @internal
	 */
	readonly ops: InvertibleMutationOp<Schema>[] = []

	constructor(
		/**
		 * @internal
		 */
		readonly tupleDbTx: TupleRootTransactionApi<SchemaToTupleSchema<Schema>>,
	) {}

	list<Collection extends CollectionName<Schema>>(
		collection: Collection,
	): Readonly<Schema[Collection]>[] {
		const transaction = getCollectionTransaction(this.tupleDbTx, collection)
		const results = transaction.scan()

		return results.map((result) => result.value)
	}

	scan<Collection extends CollectionName<Schema>>(
		collection: Collection,
		args?: CollectionScanArgs<Schema[Collection]["id"]>,
	): Readonly<Schema[Collection]>[] {
		const transaction = getCollectionTransaction(this.tupleDbTx, collection)
		const results = transaction.scan(args)

		return results.map((result) => result.value)
	}

	get<Collection extends CollectionName<Schema>>(
		collection: Collection,
		id: Schema[Collection]["id"],
	): Readonly<Schema[Collection]> | undefined {
		const tupleSchemaKey = collectionIdToTuple(id) as CollectionTupleKey<
			Schema,
			Collection
		>
		return getCollectionTransaction(this.tupleDbTx, collection).get(
			tupleSchemaKey,
		)
	}

	set<Collection extends CollectionName<Schema>>(
		collection: Collection,
		record: Schema[Collection],
	): Transaction<Schema> {
		const tupleSchemaKey = collectionIdToTuple(record.id) as CollectionTupleKey<
			Schema,
			Collection
		>
		const transaction = getCollectionTransaction(this.tupleDbTx, collection)
		const prevValue = transaction.get(tupleSchemaKey)

		transaction.set(tupleSchemaKey, record)

		const setOp: InvertibleMutationOp<Schema> = {
			type: "set",
			collection,
			value: record,
		}

		if (prevValue !== undefined) {
			setOp.prevValue = prevValue
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
		const tupleSchemaKey = collectionIdToTuple(id) as CollectionTupleKey<
			Schema,
			Collection
		>

		const transaction = getCollectionTransaction(this.tupleDbTx, collection)
		const prevRecord = transaction.get(tupleSchemaKey)
		if (prevRecord === undefined) return this

		const updatedRecord = updateFn(prevRecord)
		if (updatedRecord === prevRecord) {
			return this
		}

		transaction.set(tupleSchemaKey, updatedRecord)

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
		const tupleSchemaKey = collectionIdToTuple(id) as CollectionTupleKey<
			Schema,
			Collection
		>

		const transaction = getCollectionTransaction(this.tupleDbTx, collection)
		const value = transaction.get(tupleSchemaKey)

		transaction.remove(tupleSchemaKey)

		if (value !== undefined) {
			this.ops.push({
				type: "remove",
				collection,
				id,
				value,
			})
		}

		return this
	}

	cancel() {
		this.tupleDbTx.cancel()
	}
}
