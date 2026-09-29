import type { TupleRootTransactionApi } from "tuple-database"
import {
	type AnySchema,
	type CollectionName,
	collectionIdToTuple,
	type SchemaToTupleSchema,
} from "../schema/Schema.js"
import type {
	Mutation,
	MutationId,
	MutationOp,
} from "../transaction/Transaction.js"
import type { Patch } from "./SyncEngine.js"

type RecordTuple<Schema extends AnySchema> = SchemaToTupleSchema<Schema>
type RecordTupleKey<Schema extends AnySchema> = RecordTuple<Schema>["key"]
type RecordValue<Schema extends AnySchema> = RecordTuple<Schema>["value"]
type TupleTransaction<Schema extends AnySchema> = TupleRootTransactionApi<
	RecordTuple<Schema>
>
type RecordWriter<Schema extends AnySchema> = {
	set(key: RecordTupleKey<Schema>, value: RecordValue<Schema>): unknown
	remove(key: RecordTupleKey<Schema>): unknown
}

// tuple-database cannot narrow a key's value type while Schema is generic, so
// write through a view typed by the record tuple instead.
function writerOf<Schema extends AnySchema>(
	tx: TupleTransaction<Schema>,
): RecordWriter<Schema> {
	return tx as unknown as RecordWriter<Schema>
}

type BaseEntry<Schema extends AnySchema> = {
	/** The record's tuple key, for writing it during a rebuild. */
	key: RecordTupleKey<Schema>
	/** The server's latest value, or undefined when the server has no such record. */
	value: RecordValue<Schema> | undefined
	/** The newest pending mutation that writes this record. */
	lastWrittenBy: MutationId
}

/** Base values read before a mutation commits, for the records it writes first. */
export type BaseCapture<Schema extends AnySchema> = ReadonlyMap<
	string,
	RecordValue<Schema> | undefined
>

function recordKey<Schema extends AnySchema>(
	collection: CollectionName<Schema>,
	id: Schema[CollectionName<Schema>]["id"],
): RecordTupleKey<Schema> {
	return [
		"record",
		collection,
		...collectionIdToTuple(id),
	] as unknown as RecordTupleKey<Schema>
}

function opKey<Schema extends AnySchema>(
	op: MutationOp<Schema>,
): RecordTupleKey<Schema> {
	return op.type === "set"
		? recordKey<Schema>(op.collection, op.value.id)
		: recordKey<Schema>(op.collection, op.id)
}

const encode = (key: readonly unknown[]) => JSON.stringify(key)

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
			key: RecordTupleKey<Schema>,
		) => RecordValue<Schema> | undefined,
	): BaseCapture<Schema> {
		const capture = new Map<string, RecordValue<Schema> | undefined>()
		for (const op of mutation.ops) {
			const key = opKey(op)
			const encoded = encode(key)
			if (this.base.has(encoded) || capture.has(encoded)) continue
			capture.set(encoded, readCommitted(key))
		}
		return capture
	}

	/** Records a committed mutation, with the base captured before it committed. */
	add(mutation: Mutation<Schema>, capture: BaseCapture<Schema>): void {
		for (const op of mutation.ops) {
			const key = opKey(op)
			const encoded = encode(key)
			const entry = this.base.get(encoded) ?? {
				key,
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
		tx: TupleTransaction<Schema>,
		patch: Patch<Schema>,
		lastMutationId: MutationId,
	): void {
		const writer = writerOf(tx)
		for (const op of patch.set ?? []) {
			const key = recordKey<Schema>(op.collection, op.value.id)
			const value = op.value as RecordValue<Schema>
			const entry = this.base.get(encode(key))
			if (entry) entry.value = value
			writer.set(key, value)
		}
		for (const op of patch.remove ?? []) {
			const key = recordKey<Schema>(op.collection, op.id)
			const entry = this.base.get(encode(key))
			if (entry) entry.value = undefined
			writer.remove(key)
		}

		this.mutations = this.mutations.filter(
			(mutation) => mutation.id > lastMutationId,
		)
		this.rebuild(writer)

		// Only now: the rebuild above still needed these entries.
		for (const [encoded, entry] of this.base) {
			if (entry.lastWrittenBy <= lastMutationId) this.base.delete(encoded)
		}
	}

	/** Drops mutations the server rejected and writes the rebuild into tx. */
	reject(
		tx: TupleTransaction<Schema>,
		rejected: readonly Mutation<Schema>[],
	): void {
		const rejectedIds = new Set(rejected.map((mutation) => mutation.id))
		this.mutations = this.mutations.filter(
			(mutation) => !rejectedIds.has(mutation.id),
		)
		this.rebuild(writerOf(tx))

		const lastWrittenBy = new Map<string, MutationId>()
		for (const mutation of this.mutations) {
			for (const op of mutation.ops) {
				lastWrittenBy.set(encode(opKey(op)), mutation.id)
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

	private rebuild(writer: RecordWriter<Schema>): void {
		for (const { key, value } of this.base.values()) {
			if (value === undefined) writer.remove(key)
			else writer.set(key, value)
		}
		// One op at a time, in order: tx.write applies every remove before every
		// set, which would reorder a mutation that sets and then removes a record.
		for (const mutation of this.mutations) {
			for (const op of mutation.ops) {
				if (op.type === "set") {
					writer.set(opKey(op), op.value as RecordValue<Schema>)
				} else {
					writer.remove(opKey(op))
				}
			}
		}
	}
}
