import type {
	AnySchema,
	PatchSetOp,
	PokeAppendOp,
	PokePayload,
	Revision,
} from "@tanishqkancharla/tandem-core"
import { unreachable } from "@tanishqkancharla/tandem-core"

type AppendedField = { field: string; offset: number; text: string }

/** What a client should learn about one record from the commits merged so far. */
export type LiveChange<Schema extends AnySchema> =
	| { type: "set"; op: PatchSetOp<Schema> }
	| {
			type: "append"
			/** The full record after the latest append, sent instead if the appends cannot chain. */
			op: PatchSetOp<Schema>
			fields: AppendedField[]
			/** A revision from which the record held the value the first append extends. */
			after: Revision
	  }

/**
 * Appends the later change's text to the earlier one's, or returns undefined
 * if a field's text does not start where the earlier text ended.
 */
function chainFields(earlier: AppendedField[], later: AppendedField[]) {
	const fields = earlier.map((field) => ({ ...field }))
	for (const next of later) {
		const previous = fields.find(({ field }) => field === next.field)
		if (!previous) {
			fields.push({ ...next })
			continue
		}
		if (previous.offset + previous.text.length !== next.offset) return
		previous.text += next.text
	}
	return fields
}

/**
 * One client's live changes since its last payload, merged per record in
 * commit order, so a burst of commits goes out as one payload.
 */
export class LivePayloadBuffer<Schema extends AnySchema> {
	// Changes by record ID, in the order each record first changed.
	private readonly changes = new Map<string, LiveChange<Schema>>()
	// The latest commit merged in. The payload reflects the server at it.
	private revision?: Revision

	get isEmpty() {
		return this.changes.size === 0
	}

	/** Merges one commit's change to a record into the buffered changes. */
	add(revision: Revision, id: string, change: LiveChange<Schema>) {
		this.revision = revision
		this.changes.set(id, this.merge(this.changes.get(id), change))
	}

	clear() {
		this.changes.clear()
		this.revision = undefined
	}

	/** Builds the payload and empties the buffer. */
	take(): PokePayload<Schema> | undefined {
		const revision = this.revision
		if (!revision || this.isEmpty) return
		const set: PatchSetOp<Schema>[] = []
		const append: PokeAppendOp<Schema>[] = []
		for (const change of this.changes.values()) {
			switch (change.type) {
				case "set":
					set.push(change.op)
					break
				case "append":
					for (const field of change.fields)
						append.push({
							collection: change.op.collection,
							id: change.op.value.id,
							...field,
							after: change.after,
						} as PokeAppendOp<Schema>)
					break
				default:
					unreachable(change)
			}
		}
		this.clear()
		return {
			revision,
			...(set.length ? { set } : {}),
			...(append.length ? { append } : {}),
		}
	}

	private merge(
		earlier: LiveChange<Schema> | undefined,
		later: LiveChange<Schema>,
	): LiveChange<Schema> {
		if (later.type !== "append" || earlier?.type !== "append") {
			// After a buffered set, the client has never seen the value an append
			// extends, so the record goes whole.
			return later.type === "append" && earlier
				? { type: "set", op: later.op }
				: later
		}
		const fields = chainFields(earlier.fields, later.fields)
		return fields
			? { type: "append", op: later.op, fields, after: earlier.after }
			: { type: "set", op: later.op }
	}
}
