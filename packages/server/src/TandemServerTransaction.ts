import type {
	AnySchema,
	CollectionName,
	RelationalQuery,
	RelationalQueryResult,
	AnyRelations,
} from "@tanishqkancharla/tandem-core"
import { executeQueryAsync } from "@tanishqkancharla/tandem-core/internal"
import * as errore from "errore"
import type { AsyncTupleRootTransactionApi } from "tuple-database"
import { TandemServerError } from "./TandemServerError"
import type { TandemTuple } from "./storage/TandemServerStorage"

type CollectionTupleKey<
	Schema extends AnySchema,
	Collection extends CollectionName<Schema>,
> = ["record", Collection, Schema[Collection]["id"]]

type CollectionTransactionApi<
	Schema extends AnySchema,
	Collection extends CollectionName<Schema>,
> = {
	scan(args: { prefix: ["record", Collection] }): Promise<
		{
			key: CollectionTupleKey<Schema, Collection>
			value: Schema[Collection]
		}[]
	>
	get(
		key: CollectionTupleKey<Schema, Collection>,
	): Promise<Schema[Collection] | undefined>
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
	transaction: AsyncTupleRootTransactionApi<TandemTuple<Schema>>,
	_collection: Collection,
): CollectionTransactionApi<Schema, Collection> {
	// tuple-database's key filtering cannot reduce a mapped tuple union while
	// Schema is generic. Narrow the transaction once per selected collection.
	return transaction as unknown as CollectionTransactionApi<Schema, Collection>
}

function stageTransactionWrite(
	operation: "remove" | "set" | "update",
	write: () => void,
): TandemServerError | undefined {
	const result = errore.try(write)
	return result instanceof Error
		? new TandemServerError({ operation, cause: result })
		: undefined
}

export class TandemServerTransaction<
	Schema extends AnySchema,
	Relations extends AnyRelations<Schema>,
> {
	constructor(
		private readonly tupleDbTx: AsyncTupleRootTransactionApi<
			TandemTuple<Schema>
		>,
		private readonly relations: Relations,
	) {}

	async query<Query extends RelationalQuery<Schema, Relations>>(
		query: Query,
	): Promise<RelationalQueryResult<Schema, Relations, Query>> {
		const result = await executeQueryAsync<Schema, Relations, Query>(
			this.tupleDbTx,
			this.relations,
			query,
		).catch((cause) => new TandemServerError({ operation: "query", cause }))
		if (result instanceof Error) throw result
		return result
	}

	async list<Collection extends CollectionName<Schema>>(
		collection: Collection,
	): Promise<Readonly<Schema[Collection]>[]> {
		const transaction = getCollectionTransaction(this.tupleDbTx, collection)
		const result = await transaction
			.scan({
				prefix: ["record", collection],
			})
			.catch((cause) => new TandemServerError({ operation: "list", cause }))

		if (result instanceof Error) throw result
		return result.map(({ value }) => value)
	}

	async get<Collection extends CollectionName<Schema>>(
		collection: Collection,
		id: Schema[Collection]["id"],
	): Promise<Readonly<Schema[Collection]> | undefined> {
		const transaction = getCollectionTransaction(this.tupleDbTx, collection)
		const key: CollectionTupleKey<Schema, Collection> = [
			"record",
			collection,
			id,
		]
		const result = await transaction
			.get(key)
			.catch((cause) => new TandemServerError({ operation: "get", cause }))

		if (result instanceof Error) throw result
		return result
	}

	set<Collection extends CollectionName<Schema>>(
		collection: Collection,
		record: Schema[Collection],
	): this {
		const transaction = getCollectionTransaction(this.tupleDbTx, collection)
		const key: CollectionTupleKey<Schema, Collection> = [
			"record",
			collection,
			record.id,
		]
		const result = stageTransactionWrite("set", () => {
			transaction.set(key, record)
		})

		if (result instanceof Error) throw result
		return this
	}

	async update<Collection extends CollectionName<Schema>>(
		collection: Collection,
		id: Schema[Collection]["id"],
		updateFn: (record: Readonly<Schema[Collection]>) => Schema[Collection],
	): Promise<this> {
		const transaction = getCollectionTransaction(this.tupleDbTx, collection)
		const key: CollectionTupleKey<Schema, Collection> = [
			"record",
			collection,
			id,
		]
		const existing = await transaction
			.get(key)
			.catch((cause) => new TandemServerError({ operation: "update", cause }))
		if (existing instanceof Error) throw existing
		if (!existing) return this

		const updated = updateFn(existing)
		if (updated === existing) return this

		const result = stageTransactionWrite("update", () => {
			transaction.set(key, updated)
		})
		if (result instanceof Error) throw result
		return this
	}

	remove<Collection extends CollectionName<Schema>>(
		collection: Collection,
		id: Schema[Collection]["id"],
	): this {
		const transaction = getCollectionTransaction(this.tupleDbTx, collection)
		const key: CollectionTupleKey<Schema, Collection> = [
			"record",
			collection,
			id,
		]
		const result = stageTransactionWrite("remove", () => {
			transaction.remove(key)
		})

		if (result instanceof Error) throw result
		return this
	}

	async cancel(): Promise<void> {
		const result = await this.tupleDbTx
			.cancel()
			.catch((cause) => new TandemServerError({ operation: "cancel", cause }))
		if (result instanceof Error) throw result
	}

	/**
	 * @internal
	 */
	async commit(): Promise<boolean> {
		const hasWrites =
			this.tupleDbTx.writes.set.length > 0 ||
			this.tupleDbTx.writes.remove.length > 0
		await this.tupleDbTx.commit()
		return hasWrites
	}
}
