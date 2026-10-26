import type { ScanWindow } from "../query/Query.js"
import type { AnySchema, CollectionName } from "../schema/Schema.js"
import type { CollectionCodecs } from "../schema/collectionCodecs.js"
import type { ClientId, PatchSetOp } from "../sync/SyncEngine.js"
import type { Mutation, MutationOp } from "../transaction/Transaction.js"
import { unreachable } from "../utils/typeUtils.js"

export type TabView<Schema extends AnySchema> = {
	revision: number
	lastMutationId: Mutation<Schema>["id"]
	records: PatchSetOp<Schema>[]
}

export type TabRequest<Schema extends AnySchema> =
	| {
			method: "join"
			tabId: string
			scanWindow: ScanWindow<Schema>
			connected: boolean
	  }
	| { method: "subscribe"; scanWindow: ScanWindow<Schema> }
	| { method: "commit"; mutation: Mutation<Schema>; waitForServer: boolean }
	| { method: "finishWrite"; mutationId: Mutation<Schema>["id"] }
	| {
			method:
				| "connect"
				| "disconnect"
				| "pullFromRemote"
				| "flush"
				| "clear"
				| "leave"
	  }

export type TabResult<Schema extends AnySchema = AnySchema> =
	| { ok: true; view?: TabView<Schema> }
	| { error: "unavailable"; message: string }

export type TabMessage<Schema extends AnySchema = AnySchema> =
	| { type: "hello" }
	| { type: "leader"; leaderId: string }
	| {
			type: "view"
			leaderId: string
			sessionIds: ClientId[]
			view: TabView<Schema>
	  }
	| {
			type: "request"
			leaderId: string
			sessionId: ClientId
			requestId: string
			request: TabRequest<Schema>
	  }
	| {
			type: "response"
			leaderId: string
			sessionId: ClientId
			requestId: string
			stage: "saved" | "complete"
			result: TabResult<Schema>
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

function transformMutation<Schema extends AnySchema>(
	codecs: CollectionCodecs<Schema>,
	{ id, ops }: Mutation<Schema>,
	direction: "encode" | "decode",
): Mutation<Schema> {
	return {
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
	}
}

function transformView<Schema extends AnySchema>(
	codecs: CollectionCodecs<Schema>,
	view: TabView<Schema>,
	direction: "encode" | "decode",
): TabView<Schema> {
	return {
		...view,
		records: view.records.map(
			(op) =>
				({
					collection: op.collection,
					value: transformValue(codecs, op.collection, op.value, direction),
				}) as PatchSetOp<Schema>,
		),
	}
}

export namespace TabCodec {
	export const encodeMutation = <Schema extends AnySchema>(
		codecs: CollectionCodecs<Schema>,
		mutation: Mutation<Schema>,
	) => transformMutation(codecs, mutation, "encode")

	export const decodeMutation = <Schema extends AnySchema>(
		codecs: CollectionCodecs<Schema>,
		mutation: Mutation<Schema>,
	) => transformMutation(codecs, mutation, "decode")

	export const encodeView = <Schema extends AnySchema>(
		codecs: CollectionCodecs<Schema>,
		view: TabView<Schema>,
	) => transformView(codecs, view, "encode")
	export const decodeView = <Schema extends AnySchema>(
		codecs: CollectionCodecs<Schema>,
		view: TabView<Schema>,
	) => transformView(codecs, view, "decode")
}
