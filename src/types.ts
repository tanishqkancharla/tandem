import type { WriteOps } from "tuple-database"
import { isEqual, partition, reverse } from "./utils/objectUtils"
import {
	Assert,
	AsyncUnsubscribe,
	Tagged,
	TestIsEqual,
} from "./utils/typeUtils"

export type AnyCollectionSchema = Record<string, any> & { id: string | number }

export type Attribute<CollectionSchema extends AnyCollectionSchema> =
	keyof CollectionSchema & string

export type AnySchema = Record<string, AnyCollectionSchema>

export type CollectionName<Schema extends AnySchema> = keyof Schema & string

export type ClientId = Tagged<"ClientId", string>
export type Cookie = Tagged<"Cookie", number>

export type ClientApi = {
	clientId: ClientId
	poke: () => void
}

export type ScanWindow = EncodedQuery[]

export type RemoteApi<Schema extends AnySchema> = {
	connect(api: ClientApi): Promise<AsyncUnsubscribe>
	push(args: {
		mutations: Mutation<Schema>[]
		clientId: ClientId
	}): Promise<void>
	pull(
		args: { clientId: ClientId; cookie?: Cookie; scanWindow: ScanWindow }, // TODO: clean up patch
	): Promise<{
		cookie: Cookie
		patch: WriteOps
		lastMutationId?: MutationId
	}>
}

export type InveribleSetMutationOp<Schema extends AnySchema> = {
	type: "set"
} & {
	[Collection in CollectionName<Schema>]: {
		collection: Collection
		value: Schema[Collection]
		prevValue?: Schema[Collection]
	}
}[CollectionName<Schema>]

export type InveribleRemoveMutationOp<Schema extends AnySchema> = {
	type: "remove"
} & {
	[Collection in CollectionName<Schema>]: {
		collection: Collection
		id: string | number
		value: Schema[Collection]
	}
}[CollectionName<Schema>]

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

export type InvertibleMutationOp<Schema extends AnySchema> =
	| InveribleSetMutationOp<Schema>
	| InveribleRemoveMutationOp<Schema>
export type MutationOp<Schema extends AnySchema> =
	| SetMutationOp<Schema>
	| RemoveMutationOp<Schema>

export type MutationId = Tagged<"MutationId", string>
export type Mutation<Schema extends AnySchema> = {
	ops: MutationOp<Schema>[]
	id: MutationId
}
export type InvertibleMutation<Schema extends AnySchema> = {
	ops: InvertibleMutationOp<Schema>[]
	id: MutationId
}

export type EncodedQuery = {
	collection: string
	select?: readonly string[] | "*"
	where?: [attribute: string, operator: Operator, operand: any][]
	order?: [attribute: string, direction: "asc" | "desc"][]
	limit?: number
}

export type Operator = "=" | ">" | "<" | ">=" | "<="

export namespace MutationApi {
	function invertMutationOp<Schema extends AnySchema = AnySchema>(
		op: InvertibleMutationOp<Schema>,
	): MutationOp<Schema> {
		switch (op.type) {
			case "set": {
				return "prevValue" in op
					? {
							type: "set",
							collection: op.collection,
							value: op.prevValue as Schema[CollectionName<Schema>],
						}
					: {
							type: "remove",
							collection: op.collection,
							id: op.value.id,
						}
			}
			case "remove": {
				return {
					type: "set",
					collection: op.collection,
					value: op.value,
				}
			}
			default:
				throw new Error("Unknown mutation op type")
		}
	}

	export function getRollbackWrites<Schema extends AnySchema>(
		mutations: readonly InvertibleMutation<Schema>[],
	): WriteOps {
		return WriteOpsApi.merge(
			...reverse(mutations)
				.map((mutation) => mutation.ops.map(invertMutationOp))
				.map(toWriteOps),
		)
	}

	// This should probably live in database since it's tuple-specific
	export function toWriteOps(ops: MutationOp<any>[]): WriteOps {
		const [setOps, removeOps] = partition(ops, (op) => op.type === "set")

		const writeOps = {
			set: setOps.map((op) => ({
				key: ["record", op.collection, op.value.id],
				value: op.value,
			})),
			remove: removeOps.map((op) => ["record", op.collection, op.id]),
		}

		return writeOps
	}

	// export function mergeMutations<Schema extends AnySchema>(
	// 	mutations: readonly InvertibleMutation<Schema>[],
	// ): InvertibleMutation<Schema>
	// export function mergeMutations<Schema extends AnySchema>(
	// 	mutations: readonly Mutation<Schema>[],
	// ): Mutation<Schema>
	// export function mergeMutations<Schema extends AnySchema>(
	// 	mutations:
	// 		| readonly Mutation<Schema>[]
	// 		| readonly InvertibleMutation<Schema>[],
	// ): Mutation<Schema> | InvertibleMutation<Schema> {
	// 	const setOps = new Map<
	// 		string | number,
	// 		SetMutationOp<Schema> | InveribleSetMutationOp<Schema>
	// 	>()
	// 	const removeOps = new Map<
	// 		string | number,
	// 		RemoveMutationOp<Schema> | InveribleRemoveMutationOp<Schema>
	// 	>()

	// 	for (const mutation of mutations) {
	// 		for (const op of mutation.ops) {
	// 			if (op.type === "set") {
	// 				if (removeOps.has(op.value.id)) {
	// 					removeOps.delete(op.value.id)
	// 				}

	// 				setOps.set(op.value.id, op)
	// 			} else if (op.type === "remove") {
	// 				if (setOps.has(op.id)) {
	// 					setOps.delete(op.id)
	// 				}

	// 				removeOps.set(op.id, op)
	// 			}
	// 		}
	// 	}

	// 	return {
	// 		ops: [...setOps.values(), ...removeOps.values()],
	// 		id: tag(randomNumber().toString()),
	// 	}
	// }

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
		query: EncodedQuery,
	): boolean {
		for (const op of mutation.ops) {
			const { collection } = query
			if (op.collection !== collection) continue

			// TODO: use select and where
			return true
		}

		return false
	}

	export function intersectsScanWindow<Schema extends AnySchema>(
		mutation: Mutation<Schema>,
		scanWindow: ScanWindow,
	): boolean {
		return scanWindow.some((query) => intersectsQuery(mutation, query))
	}
}

export namespace WriteOpsApi {
	export function toString(writeOps: WriteOps): string {
		return `WriteOps {\n${
			writeOps.set
				?.map(
					(op) =>
						`  set (${op.key[1]}) ${JSON.stringify(op.value, undefined, 2)}`,
				)
				.join("\n") ?? ""
		}\n${writeOps.remove?.map((op) => `  remove (${op})`).join("\n") ?? ""}}`
	}

	export function merge(...allWriteOps: WriteOps[]): WriteOps {
		const target: WriteOps = {
			set: [],
			remove: [],
		}

		for (const { set = [], remove = [] } of allWriteOps) {
			for (const { key, value } of set) {
				// Filter out all the keys that we marked as set
				target.remove = target.remove?.filter(
					(removedKey) => !isEqual(removedKey, key),
				)

				target.set ??= []
				target.set.push({ key, value })
			}

			for (const key of remove) {
				target.set = target.set?.filter(
					({ key: keySet }) => !isEqual(keySet, key),
				)

				target.remove ??= []
				target.remove.push(key)
			}
		}

		return target
	}
}

export type Thenable = { then: (callback: () => void) => Thenable }
export type SchemaToTupleSchema<Schema extends AnySchema> = {
	[C in CollectionName<Schema>]: {
		key: ["record", collection: C, id: Schema[C]["id"]]
		value: Schema[C]
	}
}[CollectionName<Schema>]

type _TestSchemaToTupleSchema1 = Assert<
	TestIsEqual<
		SchemaToTupleSchema<{
			todos: {
				id: string
				text: string
				complete: boolean
			}
		}>,
		{
			key: ["record", "todos", string]
			value: { id: string; text: string; complete: boolean }
		}
	>
>
