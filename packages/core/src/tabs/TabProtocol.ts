import type { ScanWindow } from "../query/Query.js"
import type { AnySchema, CollectionName } from "../schema/Schema.js"
import type { CollectionCodecs } from "../schema/collectionCodecs.js"
import type {
	ClientId,
	Cookie,
	PatchSetOp,
	PullResponse,
} from "../sync/SyncEngine.js"
import type { Mutation, MutationOp } from "../transaction/Transaction.js"
import { unreachable } from "../utils/typeUtils.js"

/** Calls a tab session makes on the leader tab. */
export type TabRequest<Schema extends AnySchema> =
	| { method: "push"; mutations: Mutation<Schema>[] }
	| { method: "pull"; cookie?: Cookie; scanWindow: ScanWindow<Schema> }
	| {
			method:
				| "connect"
				| "disconnect"
				| "pullFromRemote"
				| "flush"
				| "clear"
				| "leave"
	  }

export type TabMessage =
	/** A session asks the current leader to announce itself. */
	| { type: "hello" }
	| { type: "leader"; leaderId: string }
	/** The leader's records changed; sessions should pull. */
	| { type: "poke"; leaderId: string }
	| {
			type: "request"
			leaderId: string
			sessionId: ClientId
			requestId: string
			request: TabRequest<AnySchema>
	  }
	| {
			type: "response"
			leaderId: string
			sessionId: ClientId
			requestId: string
			result: unknown
	  }

// Records cross tabs by structured clone, which drops class instances. Collection
// codecs turn values into plain data first, as IndexedDB storage does.
function transformValue<Schema extends AnySchema>(
	codecs: CollectionCodecs<Schema>,
	collection: CollectionName<Schema>,
	value: unknown,
	direction: "encode" | "decode",
) {
	const codec = codecs[collection]
	return codec ? codec[direction](value) : value
}

function transformMutations<Schema extends AnySchema>(
	codecs: CollectionCodecs<Schema>,
	mutations: Mutation<Schema>[],
	direction: "encode" | "decode",
): Mutation<Schema>[] {
	return mutations.map(({ id, ops }) => ({
		id,
		ops: ops.map((op): MutationOp<Schema> => {
			switch (op.type) {
				case "set":
					return {
						...op,
						value: transformValue(codecs, op.collection, op.value, direction),
					} as MutationOp<Schema>
				// Partial-object codecs transform a payload's supplied fields only.
				case "update":
					return {
						...op,
						payload: transformValue(
							codecs,
							op.collection,
							op.payload,
							direction,
						),
					} as MutationOp<Schema>
				case "remove":
					return op
				default:
					return unreachable(op)
			}
		}),
	}))
}

function transformPull<Schema extends AnySchema>(
	codecs: CollectionCodecs<Schema>,
	response: PullResponse<Schema>,
	direction: "encode" | "decode",
): PullResponse<Schema> {
	return {
		...response,
		patch: {
			...response.patch,
			set: response.patch.set?.map(
				(op) =>
					({
						collection: op.collection,
						value: transformValue(codecs, op.collection, op.value, direction),
					}) as PatchSetOp<Schema>,
			),
		},
	}
}

export namespace TabCodec {
	export const encodeMutations = <Schema extends AnySchema>(
		codecs: CollectionCodecs<Schema>,
		mutations: Mutation<Schema>[],
	) => transformMutations(codecs, mutations, "encode")

	export const decodeMutations = <Schema extends AnySchema>(
		codecs: CollectionCodecs<Schema>,
		mutations: Mutation<Schema>[],
	) => transformMutations(codecs, mutations, "decode")

	export const encodePull = <Schema extends AnySchema>(
		codecs: CollectionCodecs<Schema>,
		response: PullResponse<Schema>,
	) => transformPull(codecs, response, "encode")

	export const decodePull = <Schema extends AnySchema>(
		codecs: CollectionCodecs<Schema>,
		response: PullResponse<Schema>,
	) => transformPull(codecs, response, "decode")
}
