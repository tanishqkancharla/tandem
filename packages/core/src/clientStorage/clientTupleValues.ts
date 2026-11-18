import type { AnySchema } from "../schema/Schema.js"
import type { MutationOp } from "../transaction/Transaction.js"
import type { Codec } from "../utils/Codec.js"
import { unreachable, type Json } from "../utils/typeUtils.js"
import type {
	TandemClientBase,
	TandemClientTuple,
} from "./TandemClientStorage.js"

export type AnyStorageSchema<Schema extends AnySchema> = {
	[K in keyof Schema]?: Json
}

/**
 * Applies each collection's codec to the record values a client tuple holds:
 * records, `set` bases, and outbox `set` values and `update` payloads.
 * Metadata and removals pass through unchanged.
 */
export function transformClientTupleValue<Schema extends AnySchema>(
	codecs: Record<string, Codec<unknown, unknown> | undefined>,
	tuple: TandemClientTuple<Schema>,
	direction: "encode" | "decode",
): unknown {
	switch (tuple.key[0]) {
		case "record": {
			const valueCodec = codecs[tuple.key[1]]
			return valueCodec ? valueCodec[direction](tuple.value) : tuple.value
		}
		case "base": {
			const base = tuple.value as TandemClientBase<Schema[keyof Schema]>
			switch (base.server.type) {
				case "set": {
					const valueCodec = codecs[tuple.key[1]]
					return valueCodec
						? {
								...base,
								server: {
									type: "set",
									value: valueCodec[direction](base.server.value),
								},
							}
						: base
				}
				case "remove":
					return base
				default:
					return unreachable(base.server)
			}
		}
		case "replica":
		case "mutator":
		case "session":
		case "tab-write":
			return tuple.value
		case "outbox":
			return (tuple.value as MutationOp<Schema>[]).map((op) => {
				switch (op.type) {
					case "set": {
						const valueCodec = codecs[op.collection]
						return valueCodec
							? { ...op, value: valueCodec[direction](op.value) }
							: op
					}
					case "update": {
						const valueCodec = codecs[op.collection]
						return valueCodec
							? { ...op, payload: valueCodec[direction](op.payload) }
							: op
					}
					case "remove":
						return op
					default:
						return unreachable(op)
				}
			})
		default:
			return unreachable(tuple.key)
	}
}
