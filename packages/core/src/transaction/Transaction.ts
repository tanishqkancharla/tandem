import type {
	TupleRootTransactionApi,
	TupleTransactionApi,
} from "tuple-database"
import * as errore from "errore"
import type {
	TandemClientBase,
	TandemClientTuple,
} from "../clientStorage/TandemClientStorage.js"
import type {
	AnySchema,
	CollectionIdPart,
	CollectionIdTuple,
	CollectionName,
	CollectionScanArgs,
	RuntimeSchemaDefinition,
} from "../schema/Schema.js"
import { collectionIdToTuple } from "../schema/Schema.js"
import type { EncodedQuery, ScanWindow } from "../query/Query.js"
import type { Tagged } from "../utils/typeUtils.js"
import { codec as createCodec, type Codec } from "../utils/Codec.js"
import { isObject, isString } from "../utils/objectUtils.js"
import type { MutatorCall } from "../mutator/Mutator.js"

// Namespace-wide reconciliation handles records from any collection in Schema.
// Public collection methods below retain collection-specific record and ID types.
export type TupleClientRecord<Schema extends AnySchema> = {
	key: [collection: CollectionName<Schema>, ...id: CollectionIdPart[]]
	value: Schema[CollectionName<Schema>]
}

export type TupleClientBase<Schema extends AnySchema> = {
	key: TupleClientRecord<Schema>["key"]
	value: TandemClientBase<Schema[CollectionName<Schema>]>
}

export type TupleClientOutbox<Schema extends AnySchema> = {
	key: [MutationId]
	value: MutationOp<Schema>[]
}

/** The mutator call behind a pending mutation, kept beside its recorded operations. */
export type TupleClientMutator = {
	key: [MutationId]
	value: MutatorCall
}

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

export function getCollectionTransaction<
	Schema extends AnySchema,
	Collection extends CollectionName<Schema>,
>(
	transaction: TupleRootTransactionApi<TandemClientTuple<AnySchema>>,
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

export type UpdateMutationOp<Schema extends AnySchema> = {
	type: "update"
} & {
	[Collection in CollectionName<Schema>]: {
		collection: Collection
		id: Schema[Collection]["id"]
		payload: Partial<Omit<Schema[Collection], "id">> & { id?: never }
	}
}[CollectionName<Schema>]

export type MutationOp<Schema extends AnySchema> =
	| SetMutationOp<Schema>
	| RemoveMutationOp<Schema>
	| UpdateMutationOp<Schema>

/**
 * A per-client counter: a client's first committed mutation is 1, and each
 * commit adds 1. A server acknowledges every mutation up to an id at once.
 */
export type MutationId = Tagged<"MutationId", number>
export type Mutation<Schema extends AnySchema> = {
	ops: MutationOp<Schema>[]
	id: MutationId
	/**
	 * Set for a named mutation. The server runs the mutator with these
	 * arguments and ignores `ops`, which the client sends empty.
	 */
	mutator?: MutatorCall
}

/** Fields `append` can extend: those whose value is a string, never `id`. */
export type AppendableField<Record> = {
	[Field in keyof Record]-?: Field extends "id"
		? never
		: Exclude<Record[Field], undefined> extends string
			? string extends Exclude<Record[Field], undefined>
				? Field
				: never
			: never
}[keyof Record] &
	string

/** Text to add to the end of each named string field. */
export type AppendPayload<Record> = {
	[Field in AppendableField<Record>]?: string
}

/** @internal */
export class AppendPayloadError extends errore.createTaggedError({
	name: "AppendPayloadError",
	message: "$detail",
}) {}

/** @internal */
export function validateAppendPayload(payload: unknown) {
	if (!isObject(payload) || Array.isArray(payload))
		return new AppendPayloadError({
			detail: "Append payload must be an object",
		})
	if (Object.hasOwn(payload, "id"))
		return new AppendPayloadError({
			detail: "An append cannot change record identity",
		})
	if (Object.values(payload).some((text) => typeof text !== "string"))
		return new AppendPayloadError({ detail: "Appended text must be a string" })
}

/** @internal */
export class UpdatePayloadError extends errore.createTaggedError({
	name: "UpdatePayloadError",
	message: "$detail",
}) {}

/** @internal */
export function validateUpdatePayload(payload: unknown) {
	if (!isObject(payload) || Array.isArray(payload))
		return new UpdatePayloadError({
			detail: "Update payload must be an object",
		})
	if (Object.hasOwn(payload, "id"))
		return new UpdatePayloadError({
			detail: "An update cannot change record identity",
		})
}

class MutationCodecInputError extends errore.createTaggedError({
	name: "MutationCodecInputError",
	message: "Invalid mutation: $detail",
}) {}

export namespace MutationApi {
	/** Serialize at transport boundaries; RemoteApi itself carries runtime values. */
	export function codec<Schema extends AnySchema>(
		schema: RuntimeSchemaDefinition<Schema>,
	): Codec<Mutation<Schema>, unknown> {
		function transform(input: unknown, direction: "encode" | "decode") {
			if (
				!isObject(input) ||
				!Number.isSafeInteger(input.id) ||
				(input.id as number) < 1 ||
				!Array.isArray(input.ops)
			) {
				return new MutationCodecInputError({
					detail: "expected an id and operations",
				})
			}
			if (
				input.mutator !== undefined &&
				(!isObject(input.mutator) || !isString(input.mutator.name))
			) {
				return new MutationCodecInputError({
					detail: "expected a mutator name",
				})
			}
			const ops: Record<string, unknown>[] = []
			for (const operation of input.ops) {
				if (
					!isObject(operation) ||
					typeof operation.collection !== "string" ||
					!Object.hasOwn(schema.collections, operation.collection)
				) {
					return new MutationCodecInputError({ detail: "unknown collection" })
				}
				const valueCodec = schema.collections[operation.collection].codec
				// Field codecs are consumer code and can throw on invalid wire values.
				const transformed = errore.try({
					try: (): Record<string, unknown> | MutationCodecInputError => {
						switch (operation.type) {
							case "set":
								return {
									...operation,
									value: valueCodec
										? valueCodec[direction](operation.value)
										: operation.value,
								}
							case "update": {
								const identity = valueCodec
									? (valueCodec[direction]({ id: operation.id }) as {
											id: unknown
										})
									: { id: operation.id }
								return {
									...operation,
									id: identity.id,
									payload: valueCodec
										? valueCodec[direction](operation.payload)
										: operation.payload,
								}
							}
							case "remove": {
								const identity = valueCodec
									? (valueCodec[direction]({ id: operation.id }) as {
											id: unknown
										})
									: { id: operation.id }
								return { ...operation, id: identity.id }
							}
							default:
								return new MutationCodecInputError({
									detail: "unknown operation type",
								})
						}
					},
					catch: (cause) =>
						new MutationCodecInputError({
							detail: "collection codec rejected input",
							cause,
						}),
				})
				if (transformed instanceof Error) return transformed
				if (direction === "decode") {
					const id =
						operation.type === "set"
							? isObject(transformed.value)
								? transformed.value.id
								: undefined
							: transformed.id
					const parts = Array.isArray(id) ? id : [id]
					if (
						parts.length === 0 ||
						parts.some(
							(part) =>
								typeof part !== "string" &&
								!(typeof part === "number" && Number.isFinite(part)),
						)
					) {
						return new MutationCodecInputError({
							detail: "expected a record identity",
						})
					}
				}
				ops.push(transformed)
			}
			return { ...input, ops }
		}

		return createCodec(
			"Mutation",
			(input) => {
				const output = transform(input, "encode")
				if (output instanceof Error) throw output
				return output
			},
			(input) => {
				const output = transform(input, "decode")
				if (output instanceof Error) throw output
				return output as Mutation<Schema>
			},
		)
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
			case "update":
				return `update (${op.collection}) ${op.id} ${JSON.stringify(op.payload, undefined, 2)}`
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
	readonly ops: MutationOp<Schema>[] = []

	/** @internal */
	readonly tupleDbTx: TupleRootTransactionApi<TandemClientTuple<AnySchema>>

	constructor(
		tupleDbTx: TupleRootTransactionApi<TandemClientTuple<AnySchema>>,
	) {
		this.tupleDbTx = tupleDbTx
	}

	// tuple-database cannot reduce our generic mapped schema by prefix. Each
	// subspace fixes the namespace; these assertions restore Schema to its values.
	// These are views of tupleDbTx, not independent transactions.
	/** @internal */
	get records() {
		return this.tupleDbTx.subspace([
			"record",
		]) as unknown as TupleTransactionApi<TupleClientRecord<Schema>>
	}

	/** @internal */
	get bases() {
		return this.tupleDbTx.subspace(["base"]) as unknown as TupleTransactionApi<
			TupleClientBase<Schema>
		>
	}

	/** @internal */
	get mutators() {
		return this.tupleDbTx.subspace([
			"mutator",
		]) as unknown as TupleTransactionApi<TupleClientMutator>
	}

	/** @internal */
	get outbox() {
		return this.tupleDbTx.subspace([
			"outbox",
		]) as unknown as TupleTransactionApi<TupleClientOutbox<Schema>>
	}

	list<Collection extends CollectionName<Schema>>(
		collection: Collection,
	): Readonly<Schema[Collection]>[] {
		const transaction = getCollectionTransaction<Schema, Collection>(
			this.tupleDbTx,
			collection,
		)
		const results = transaction.scan()

		return results.map((result) => result.value)
	}

	scan<Collection extends CollectionName<Schema>>(
		collection: Collection,
		args?: CollectionScanArgs<Schema[Collection]["id"]>,
	): Readonly<Schema[Collection]>[] {
		const transaction = getCollectionTransaction<Schema, Collection>(
			this.tupleDbTx,
			collection,
		)
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
		return getCollectionTransaction<Schema, Collection>(
			this.tupleDbTx,
			collection,
		).get(tupleSchemaKey)
	}

	set<Collection extends CollectionName<Schema>>(
		collection: Collection,
		record: Schema[Collection],
	): Transaction<Schema> {
		const tupleSchemaKey = collectionIdToTuple(record.id) as CollectionTupleKey<
			Schema,
			Collection
		>
		getCollectionTransaction<Schema, Collection>(
			this.tupleDbTx,
			collection,
		).set(tupleSchemaKey, record)
		this.ops.push({ type: "set", collection, value: record })

		return this
	}

	/** Assigns supplied top-level fields only if the record exists. */
	update<Collection extends CollectionName<Schema>>(
		collection: Collection,
		id: Schema[Collection]["id"],
		payload: Partial<Omit<Schema[Collection], "id">> & { id?: never },
	): Transaction<Schema> {
		const invalid = validateUpdatePayload(payload)
		if (invalid instanceof Error) throw invalid
		const assignments = { ...payload }
		if (Object.keys(assignments).length === 0) return this

		const tupleSchemaKey = collectionIdToTuple(id) as CollectionTupleKey<
			Schema,
			Collection
		>

		const transaction = getCollectionTransaction<Schema, Collection>(
			this.tupleDbTx,
			collection,
		)
		const prevRecord = transaction.get(tupleSchemaKey)
		if (prevRecord === undefined) return this

		transaction.set(tupleSchemaKey, { ...prevRecord, ...assignments })
		this.ops.push({ type: "update", collection, id, payload: assignments })

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

		getCollectionTransaction<Schema, Collection>(
			this.tupleDbTx,
			collection,
		).remove(tupleSchemaKey)
		// Recorded even when the record isn't local, so the server removes it too.
		this.ops.push({ type: "remove", collection, id })

		return this
	}

	cancel() {
		this.tupleDbTx.cancel()
	}
}
