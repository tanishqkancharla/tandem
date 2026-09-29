import type { TupleRootTransactionApi } from "tuple-database"
import {
	type AnySchema,
	type CollectionName,
	collectionIdToTuple,
	type SchemaToTupleSchema,
} from "../schema/Schema.js"
import {
	getCollectionTransaction,
	type Mutation,
	type MutationId,
	type MutationOp,
} from "../transaction/Transaction.js"
import type { Patch } from "./SyncEngine.js"

/** The record an op or a patch entry writes. */
type RecordRef<Schema extends AnySchema> = {
	collection: CollectionName<Schema>
	id: Schema[CollectionName<Schema>]["id"]
}

type BaseEntry<Schema extends AnySchema> = RecordRef<Schema> & {
	/** The server's latest value, or undefined when the server has no such record. */
	value: Schema[CollectionName<Schema>] | undefined
	/** The newest pending mutation that writes this record. */
	lastWrittenBy: MutationId
}

/** Base values read before a mutation commits, for the records it writes first. */
export type BaseCapture<Schema extends AnySchema> = ReadonlyMap<
	string,
	Schema[CollectionName<Schema>] | undefined
>

function refOf<Schema extends AnySchema>(
	op: MutationOp<Schema>,
): RecordRef<Schema> {
	return {
		collection: op.collection,
		id: op.type === "set" ? op.value.id : op.id,
	}
}

/** A Map key for a record: its collection followed by its id parts. */
function encode<Schema extends AnySchema>({
	collection,
	id,
}: RecordRef<Schema>): string {
	return JSON.stringify([collection, ...collectionIdToTuple(id)])
}

/** Sets the record to value, or removes it when value is undefined. */
function write<Schema extends AnySchema>(
	tx: TupleRootTransactionApi<SchemaToTupleSchema<Schema>>,
	{ collection, id }: RecordRef<Schema>,
	value: Schema[CollectionName<Schema>] | undefined,
): void {
	const records = getCollectionTransaction(tx, collection)
	if (value === undefined) records.remove(collectionIdToTuple(id))
	else records.set(collectionIdToTuple(id), value)
}

/**
 * A client's unacknowledged mutations, and the base they apply to: the
 * server's latest value for each record they write. What the app sees is the
 * base with the pending mutations replayed on top, so a pull rebuilds those
 * records from the base instead of undoing writes.
 *
 * Invariants between calls:
 * - The base has an entry exactly for the records pending mutations write,
 *   and each entry's lastWrittenBy is the highest id among them.
 * - Each entry's value is the server's latest value for that record, as far
 *   as this client knows.
 * - Each such record in the tuple database equals its base value with the
 *   pending ops on it replayed in order.
 */
export class PendingWrites<Schema extends AnySchema> {
	/** Mutations the server hasn't acknowledged, in ascending id order. */
	private mutations: Mutation<Schema>[] = []
	private readonly base = new Map<string, BaseEntry<Schema>>()

	/**
	 * Reads the committed value of each record the mutation writes that no
	 * pending mutation writes yet. Call it before the mutation commits.
	 */
	captureBase(
		mutation: Mutation<Schema>,
		readCommitted: (
			ref: RecordRef<Schema>,
		) => Schema[CollectionName<Schema>] | undefined,
	): BaseCapture<Schema> {
		const capture = new Map<
			string,
			Schema[CollectionName<Schema>] | undefined
		>()
		for (const op of mutation.ops) {
			const ref = refOf(op)
			const encoded = encode(ref)
			if (this.base.has(encoded) || capture.has(encoded)) continue
			capture.set(encoded, readCommitted(ref))
		}
		return capture
	}

	/** Records a committed mutation, with the base captured before it committed. */
	add(mutation: Mutation<Schema>, capture: BaseCapture<Schema>): void {
		for (const op of mutation.ops) {
			const ref = refOf(op)
			const encoded = encode(ref)
			const entry = this.base.get(encoded) ?? {
				...ref,
				value: capture.get(encoded),
				lastWrittenBy: mutation.id,
			}
			entry.lastWrittenBy = mutation.id
			this.base.set(encoded, entry)
		}
		this.mutations.push(mutation)
	}

	/**
	 * Writes a pull into tx: the patch, then each base record reset to the
	 * server's value, then the still-pending mutations replayed on top.
	 */
	applyPull(
		tx: TupleRootTransactionApi<SchemaToTupleSchema<Schema>>,
		patch: Patch<Schema>,
		lastMutationId: MutationId,
	): void {
		for (const op of patch.set ?? []) {
			this.receive(tx, { collection: op.collection, id: op.value.id }, op.value)
		}
		for (const op of patch.remove ?? []) {
			this.receive(tx, { collection: op.collection, id: op.id }, undefined)
		}

		this.mutations = this.mutations.filter(
			(mutation) => mutation.id > lastMutationId,
		)
		this.rebuild(tx)

		// Only now: the rebuild above still needed these entries.
		for (const [encoded, entry] of this.base) {
			if (entry.lastWrittenBy <= lastMutationId) this.base.delete(encoded)
		}
	}

	/** Drops mutations the server rejected and writes the rebuild into tx. */
	reject(
		tx: TupleRootTransactionApi<SchemaToTupleSchema<Schema>>,
		rejected: readonly Mutation<Schema>[],
	): void {
		const rejectedIds = new Set(rejected.map((mutation) => mutation.id))
		this.mutations = this.mutations.filter(
			(mutation) => !rejectedIds.has(mutation.id),
		)
		this.rebuild(tx)

		const lastWrittenBy = new Map<string, MutationId>()
		for (const mutation of this.mutations) {
			for (const op of mutation.ops) {
				lastWrittenBy.set(encode(refOf(op)), mutation.id)
			}
		}
		for (const [encoded, entry] of this.base) {
			const last = lastWrittenBy.get(encoded)
			if (last === undefined) this.base.delete(encoded)
			else entry.lastWrittenBy = last
		}
	}

	clear(): void {
		this.mutations = []
		this.base.clear()
	}

	/** Writes a server value, and keeps it as the base if a pending mutation writes the record. */
	private receive(
		tx: TupleRootTransactionApi<SchemaToTupleSchema<Schema>>,
		ref: RecordRef<Schema>,
		value: Schema[CollectionName<Schema>] | undefined,
	): void {
		const entry = this.base.get(encode(ref))
		if (entry) entry.value = value
		write(tx, ref, value)
	}

	private rebuild(
		tx: TupleRootTransactionApi<SchemaToTupleSchema<Schema>>,
	): void {
		for (const entry of this.base.values()) write(tx, entry, entry.value)
		// One op at a time, in order: tx.write applies every remove before every
		// set, which would reorder a mutation that sets and then removes a record.
		for (const mutation of this.mutations) {
			for (const op of mutation.ops) {
				write(tx, refOf(op), op.type === "set" ? op.value : undefined)
			}
		}
	}
}
