import type {
	AnySchema,
	AppendableField,
	AppendPayload,
	CollectionIdTuple,
	CollectionName,
	CollectionScanArgs,
	RelationalQuery,
	RelationalQueryResult,
	AnyRelations,
	SchemaToTupleSchema,
} from "@tanishqkancharla/tandem-core"
import {
	collectionIdToTuple,
	executeQueryAsync,
	validateAppendPayload,
	validateUpdatePayload,
} from "@tanishqkancharla/tandem-core/internal"
import * as errore from "errore"
import type { AsyncTupleRootTransactionApi } from "tuple-database"
import { TandemServerError } from "./TandemServerError.js"
import type { TandemTuple } from "./storage/TandemServerStorage.js"

type CollectionTupleKey<
	Schema extends AnySchema,
	Collection extends CollectionName<Schema>,
> = CollectionIdTuple<Schema[Collection]["id"]>

type CollectionTransactionApi<
	Schema extends AnySchema,
	Collection extends CollectionName<Schema>,
> = {
	scan(args?: CollectionScanArgs<Schema[Collection]["id"]>): Promise<
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

function stageTransactionWrite(
	operation: "append" | "remove" | "set" | "update",
	write: () => void,
): TandemServerError | undefined {
	const result = errore.try(write)
	return result instanceof Error
		? new TandemServerError({ operation, cause: result })
		: undefined
}

/** Text staged for one record, appended at commit. */
type PendingAppend<Schema extends AnySchema> = {
	collection: CollectionName<Schema>
	id: Schema[CollectionName<Schema>]["id"]
	/** Text per field, in the order the fields were first appended. */
	fields: Map<string, string>
}

/** What one commit appended to a record it did not otherwise write. */
export type AppliedAppend<Schema extends AnySchema> = {
	[Collection in CollectionName<Schema>]: {
		collection: Collection
		id: Schema[Collection]["id"]
		fields: {
			field: AppendableField<Schema[Collection]>
			/** The field's length before the append. */
			offset: number
			text: string
		}[]
	}
}[CollectionName<Schema>]

class AppendFieldError extends errore.createTaggedError({
	name: "AppendFieldError",
	message: "Cannot append to $collection.$field: its value is not a string",
}) {}

function appendKey(collection: string, id: unknown) {
	return JSON.stringify([collection, ...collectionIdToTuple(id as string)])
}

export class TandemServerTransaction<
	Schema extends AnySchema,
	Relations extends AnyRelations<Schema>,
> {
	// Appends read the record at commit, inside the server's run queue, so
	// concurrent appends to one field never lose text.
	private readonly appends = new Map<string, PendingAppend<Schema>>()

	constructor(
		private readonly tupleDbTx: AsyncTupleRootTransactionApi<
			TandemTuple<Schema>
		>,
		private readonly relations: Relations,
	) {}

	async query<Query extends RelationalQuery<Schema, Relations>>(
		query: Query,
	): Promise<RelationalQueryResult<Schema, Relations, Query>> {
		// Query execution uses full record keys on the shared root transaction.
		const records = this.tupleDbTx as unknown as AsyncTupleRootTransactionApi<
			SchemaToTupleSchema<Schema>
		>
		const result = await executeQueryAsync<Schema, Relations, Query>(
			records,
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
			.scan()
			.catch((cause) => new TandemServerError({ operation: "list", cause }))

		if (result instanceof Error) throw result
		return result.map(({ value }) => value)
	}

	async scan<Collection extends CollectionName<Schema>>(
		collection: Collection,
		args?: CollectionScanArgs<Schema[Collection]["id"]>,
	): Promise<Readonly<Schema[Collection]>[]> {
		const transaction = getCollectionTransaction(this.tupleDbTx, collection)
		const result = await transaction
			.scan(args)
			.catch((cause) => new TandemServerError({ operation: "scan", cause }))

		if (result instanceof Error) throw result
		return result.map(({ value }) => value)
	}

	async get<Collection extends CollectionName<Schema>>(
		collection: Collection,
		id: Schema[Collection]["id"],
	): Promise<Readonly<Schema[Collection]> | undefined> {
		const transaction = getCollectionTransaction(this.tupleDbTx, collection)
		const key = collectionIdToTuple(id) as CollectionTupleKey<
			Schema,
			Collection
		>
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
		const key = collectionIdToTuple(record.id) as CollectionTupleKey<
			Schema,
			Collection
		>
		const result = stageTransactionWrite("set", () => {
			transaction.set(key, record)
		})

		if (result instanceof Error) throw result
		// The record is replaced after the earlier appends.
		this.appends.delete(appendKey(collection, record.id))
		return this
	}

	/** Assigns supplied top-level fields only if the record exists. */
	async update<Collection extends CollectionName<Schema>>(
		collection: Collection,
		id: Schema[Collection]["id"],
		payload: Partial<Omit<Schema[Collection], "id">> & { id?: never },
	): Promise<this> {
		const invalid = validateUpdatePayload(payload)
		if (invalid instanceof Error) throw invalid
		const assignments = { ...payload }
		if (Object.keys(assignments).length === 0) return this

		const transaction = getCollectionTransaction(this.tupleDbTx, collection)
		const key = collectionIdToTuple(id) as CollectionTupleKey<
			Schema,
			Collection
		>
		const existing = await transaction
			.get(key)
			.catch((cause) => new TandemServerError({ operation: "update", cause }))
		if (existing instanceof Error) throw existing
		if (existing === undefined) return this

		const result = stageTransactionWrite("update", () => {
			transaction.set(key, { ...existing, ...assignments })
		})
		if (result instanceof Error) throw result
		// Assigned fields replace text appended before them.
		const pendingKey = appendKey(collection, id)
		const pending = this.appends.get(pendingKey)
		for (const field of Object.keys(assignments)) pending?.fields.delete(field)
		if (pending?.fields.size === 0) this.appends.delete(pendingKey)
		return this
	}

	/**
	 * Adds text to the end of string fields when the transaction commits, to
	 * whatever the fields hold then. A missing record is left absent. Clients
	 * that already have the record receive only the appended text.
	 */
	append<Collection extends CollectionName<Schema>>(
		collection: Collection,
		id: Schema[Collection]["id"],
		payload: AppendPayload<Schema[Collection]>,
	): this {
		const invalid = validateAppendPayload(payload)
		if (invalid instanceof Error) throw invalid
		const key = appendKey(collection, id)
		const pending: PendingAppend<Schema> = this.appends.get(key) ?? {
			collection,
			id,
			fields: new Map(),
		}
		for (const [field, text] of Object.entries(payload) as [string, string][]) {
			if (text)
				pending.fields.set(field, (pending.fields.get(field) ?? "") + text)
		}
		if (pending.fields.size) this.appends.set(key, pending)
		return this
	}

	remove<Collection extends CollectionName<Schema>>(
		collection: Collection,
		id: Schema[Collection]["id"],
	): this {
		const transaction = getCollectionTransaction(this.tupleDbTx, collection)
		const key = collectionIdToTuple(id) as CollectionTupleKey<
			Schema,
			Collection
		>
		const result = stageTransactionWrite("remove", () => {
			transaction.remove(key)
		})

		if (result instanceof Error) throw result
		this.appends.delete(appendKey(collection, id))
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
	 * Stages pending appends over the current records. Call inside the run
	 * queue, right before `commit`. Returns the appends to records this
	 * transaction did not otherwise write.
	 */
	async applyAppends(): Promise<TandemServerError | AppliedAppend<Schema>[]> {
		const applied: AppliedAppend<Schema>[] = []
		// A record this transaction set or updated reaches clients whole.
		const rewritten = new Set(
			this.recordWrites().set.map(({ key }) => JSON.stringify(key.slice(1))),
		)
		for (const [id, pending] of this.appends) {
			const transaction = getCollectionTransaction(
				this.tupleDbTx,
				pending.collection,
			)
			const key = collectionIdToTuple(pending.id) as CollectionTupleKey<
				Schema,
				typeof pending.collection
			>
			const existing = await transaction
				.get(key)
				.catch((cause) => new TandemServerError({ operation: "append", cause }))
			if (existing instanceof Error) return existing
			if (existing === undefined) continue

			const fields: { field: string; offset: number; text: string }[] = []
			let value: Record<string, unknown> = existing
			for (const [field, text] of pending.fields) {
				const current = value[field] ?? ""
				if (typeof current !== "string") {
					return new TandemServerError({
						operation: "append",
						cause: new AppendFieldError({
							collection: pending.collection,
							field,
						}),
					})
				}
				fields.push({ field, offset: current.length, text })
				value = { ...value, [field]: current + text }
			}
			const staged = stageTransactionWrite("append", () => {
				transaction.set(key, value as Schema[typeof pending.collection])
			})
			if (staged instanceof Error) return staged
			if (!rewritten.has(id))
				applied.push({
					collection: pending.collection,
					id: existing.id,
					fields,
				} as AppliedAppend<Schema>)
		}
		this.appends.clear()
		return applied
	}

	/**
	 * @internal
	 * Staged record writes. Set values are full records, including merged updates.
	 */
	recordWrites() {
		const { set, remove } = this.tupleDbTx.writes
		return {
			set: set.filter(({ key }) => key[0] === "record"),
			remove: remove.filter((key) => key[0] === "record"),
		}
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
