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
import { unreachable } from "../utils/typeUtils.js"
import type { Patch } from "./SyncEngine.js"

/** The record an op writes. */
type RecordRef<Schema extends AnySchema> = {
	collection: CollectionName<Schema>
	id: Schema[CollectionName<Schema>]["id"]
}

type BaseEntry<Schema extends AnySchema> = {
	/**
	 * The op that makes the record match the server: a set of the server's
	 * latest value, or a remove when the server has no such record.
	 */
	server: MutationOp<Schema>
	/** The newest pending mutation that writes this record. */
	lastWrittenBy: MutationId
}

function mutationOpToRecordRef<Schema extends AnySchema>(
	op: MutationOp<Schema>,
): RecordRef<Schema> {
	switch (op.type) {
		case "set":
			return { collection: op.collection, id: op.value.id }
		case "remove":
			return { collection: op.collection, id: op.id }
		default:
			return unreachable(op)
	}
}

/** The base map's key for a record: its collection followed by its id parts. */
function mutationOpToBaseKey<Schema extends AnySchema>(
	op: MutationOp<Schema>,
): string {
	const { collection, id } = mutationOpToRecordRef(op)
	return JSON.stringify([collection, ...collectionIdToTuple(id)])
}

/** Applies one set or remove to the tuple transaction. */
function applyOp<Schema extends AnySchema>(
	tx: TupleRootTransactionApi<SchemaToTupleSchema<Schema>>,
	op: MutationOp<Schema>,
): void {
	const { collection, id } = mutationOpToRecordRef(op)
	const records = getCollectionTransaction(tx, collection)
	switch (op.type) {
		case "set":
			records.set(collectionIdToTuple(id), op.value)
			return
		case "remove":
			records.remove(collectionIdToTuple(id))
			return
		default:
			unreachable(op)
	}
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
 * - Each entry's server op matches the server's latest value for that record,
 *   as far as this client knows.
 * - Each such record in the tuple database equals its base with the pending
 *   ops on it replayed in order.
 */
export class PendingWrites<Schema extends AnySchema> {
	/** Mutations the server hasn't acknowledged, in ascending id order. */
	private mutations: Mutation<Schema>[] = []
	private readonly base = new Map<string, BaseEntry<Schema>>()

	get isEmpty(): boolean {
		return this.mutations.length === 0
	}

	/** A stable send list; subsequent commits cannot extend an in-flight push. */
	snapshot(): Mutation<Schema>[] {
		return [...this.mutations]
	}

	clearAll(): void {
		this.mutations = []
		this.base.clear()
	}

	/**
	 * Runs commit and tracks the mutation as pending. Before the commit runs, it
	 * reads the committed value of each record the mutation writes that no
	 * pending mutation writes yet. If the commit throws, nothing is tracked.
	 */
	commitAndTrack(
		mutation: Mutation<Schema>,
		{
			readCommittedRecord,
			commit,
		}: {
			readCommittedRecord: (
				ref: RecordRef<Schema>,
			) => Schema[CollectionName<Schema>] | undefined
			commit: () => void
		},
	): void {
		const captured = new Map<string, MutationOp<Schema>>()
		for (const op of mutation.ops) {
			const baseKey = mutationOpToBaseKey(op)
			if (this.base.has(baseKey) || captured.has(baseKey)) continue
			const { collection, id } = mutationOpToRecordRef(op)
			const value = readCommittedRecord({ collection, id })
			captured.set(
				baseKey,
				value === undefined
					? { type: "remove", collection, id }
					: { type: "set", collection, value },
			)
		}

		commit()

		for (const [baseKey, server] of captured) {
			this.base.set(baseKey, { server, lastWrittenBy: mutation.id })
		}
		for (const op of mutation.ops) {
			const entry = this.base.get(mutationOpToBaseKey(op))
			if (entry) entry.lastWrittenBy = mutation.id
		}
		this.mutations.push(mutation)
	}

	/**
	 * Writes a pull into tx: the patch, then each base record reset to the
	 * server's value, then the still-pending mutations replayed on top.
	 */
	applyPull(
		tx: TupleRootTransactionApi<SchemaToTupleSchema<Schema>>,
		{
			patch,
			lastMutationId,
		}: { patch: Patch<Schema>; lastMutationId: MutationId },
	): void {
		if (patch.reset) {
			for (const { key } of tx.scan({})) tx.remove(key)
			// Pending records absent from the snapshot have an empty confirmed base.
			for (const entry of this.base.values()) {
				entry.server = {
					type: "remove",
					...mutationOpToRecordRef(entry.server),
				}
			}
		}
		for (const op of patch.set ?? []) {
			this.applyServerOp(tx, { type: "set", ...op })
		}
		for (const op of patch.remove ?? []) {
			this.applyServerOp(tx, { type: "remove", ...op })
		}

		this.mutations = this.mutations.filter(
			(mutation) => mutation.id > lastMutationId,
		)
		this.resetToBaseAndReplay(tx)

		// Only now: the rebuild above still needed these entries.
		for (const [baseKey, entry] of this.base) {
			if (entry.lastWrittenBy <= lastMutationId) this.base.delete(baseKey)
		}
	}

	/** Applies a patch op, and keeps it as the base if a pending mutation writes the record. */
	private applyServerOp(
		tx: TupleRootTransactionApi<SchemaToTupleSchema<Schema>>,
		op: MutationOp<Schema>,
	): void {
		const entry = this.base.get(mutationOpToBaseKey(op))
		if (entry) entry.server = op
		applyOp(tx, op)
	}

	private resetToBaseAndReplay(
		tx: TupleRootTransactionApi<SchemaToTupleSchema<Schema>>,
	): void {
		for (const entry of this.base.values()) applyOp(tx, entry.server)
		// One op at a time, in order: tx.write applies every remove before every
		// set, which would reorder a mutation that sets and then removes a record.
		for (const mutation of this.mutations) {
			for (const op of mutation.ops) applyOp(tx, op)
		}
	}
}
