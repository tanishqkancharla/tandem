import type { AsyncTupleStorageApi, WriteOps } from "tuple-database"
import { isEqual, partition, reverse } from "./utils/objectUtils"
import {
	Assert,
	AsyncUnsubscribe,
	Tagged,
	TestIsEqual,
} from "./utils/typeUtils"

export interface StorageApi extends AsyncTupleStorageApi {
	clear(): Promise<void>
}

export type AnyCollectionSchema = Record<string, any> & { id: string | number }

declare const collectionRecord: unique symbol
declare const fieldValue: unique symbol

export type RuntimeFieldDefinition<Value = unknown> = {
	readonly kind: "field"
	readonly type: string
	readonly [fieldValue]?: Value
}

export type AnyRuntimeFieldDefinition = RuntimeFieldDefinition<any>

export type CollectionDefinition<
	CollectionRecord extends AnyCollectionSchema = AnyCollectionSchema,
	CollectionCodec = unknown,
> = {
	readonly kind: "collection"
	readonly name?: string
	readonly codec?: CollectionCodec
	readonly shape?: globalThis.Record<string, AnyRuntimeFieldDefinition>
	readonly fields?: readonly (keyof CollectionRecord & string)[]
	readonly [collectionRecord]?: CollectionRecord
}

export type NamedCollectionDefinition<
	Record extends AnyCollectionSchema = AnyCollectionSchema,
	Name extends string = string,
	CollectionCodec = unknown,
> = CollectionDefinition<Record, CollectionCodec> & {
	readonly name: Name
}

export type AnyCollectionDefinition = CollectionDefinition<
	AnyCollectionSchema,
	unknown
>

export type RuntimeSchemaDefinition<Schema extends AnySchema = AnySchema> = {
	readonly collections: {
		readonly [Collection in CollectionName<Schema>]: NamedCollectionDefinition<
			Schema[Collection],
			Collection,
			unknown
		>
	}
}

export type RelationType = "many-to-one" | "one-to-many"

export type NormalizedManyToOneRelationDefinition<
	Schema extends AnySchema = AnySchema,
	SourceCollection extends CollectionName<Schema> = CollectionName<Schema>,
	TargetCollection extends CollectionName<Schema> = CollectionName<Schema>,
	RelationName extends string = string,
> = {
	readonly type: "many-to-one"
	readonly name: RelationName
	readonly sourceCollection: SourceCollection
	readonly targetCollection: TargetCollection
	readonly from: keyof Schema[SourceCollection] & string
	readonly to: "id"
}

export type NormalizedOneToManyRelationDefinition<
	Schema extends AnySchema = AnySchema,
	SourceCollection extends CollectionName<Schema> = CollectionName<Schema>,
	TargetCollection extends CollectionName<Schema> = CollectionName<Schema>,
	RelationName extends string = string,
> = {
	readonly type: "one-to-many"
	readonly name: RelationName
	readonly sourceCollection: SourceCollection
	readonly targetCollection: TargetCollection
	readonly from: "id"
	readonly to: keyof Schema[TargetCollection] & string
}

export type NormalizedRelationDefinition<
	Schema extends AnySchema = AnySchema,
	SourceCollection extends CollectionName<Schema> = CollectionName<Schema>,
	TargetCollection extends CollectionName<Schema> = CollectionName<Schema>,
	RelationName extends string = string,
> =
	| NormalizedManyToOneRelationDefinition<
			Schema,
			SourceCollection,
			TargetCollection,
			RelationName
		>
	| NormalizedOneToManyRelationDefinition<
			Schema,
			SourceCollection,
			TargetCollection,
			RelationName
		>

export type RuntimeRelationsDefinition<Schema extends AnySchema = AnySchema> = {
	readonly [SourceCollection in CollectionName<Schema>]?: {
		readonly [RelationName in string]?: NormalizedRelationDefinition<
			Schema,
			SourceCollection,
			CollectionName<Schema>,
			RelationName
		>
	}
}

export type Attribute<Schema extends AnySchema> = {
	[K in keyof Schema]: keyof Schema[K]
}[keyof Schema] &
	string

export type AnySchema = Record<string, AnyCollectionSchema>

export type CollectionName<Schema extends AnySchema> = keyof Schema & string

export type FieldWhereOperators<Value> = {
	readonly eq?: Value
	readonly gt?: Value
	readonly lt?: Value
	readonly gte?: Value
	readonly lte?: Value
}

export type RelationalSelectOptions<
	Schema extends AnySchema,
	Collection extends CollectionName<Schema>,
> = {
	readonly [Field in keyof Schema[Collection] & string]?: true
}

export type RelationalWhereOptions<
	Schema extends AnySchema,
	Collection extends CollectionName<Schema>,
> = {
	readonly [Field in keyof Schema[Collection] & string]?:
		| Schema[Collection][Field]
		| FieldWhereOperators<Schema[Collection][Field]>
}

export type RelationalOrderByOptions<
	Schema extends AnySchema,
	Collection extends CollectionName<Schema>,
> = {
	readonly [Field in keyof Schema[Collection] & string]?: "asc" | "desc"
}

type RelationTargetCollection<Relation> = Relation extends {
	readonly targetCollection: infer TargetCollection
}
	? TargetCollection
	: never

export type RelationalWithOptions<
	Schema extends AnySchema,
	Relations extends RuntimeRelationsDefinition<Schema>,
	Collection extends CollectionName<Schema>,
> = {
	readonly [RelationName in keyof NonNullable<
		Relations[Collection]
	> &
		string]?:
		| true
		| RelationalQueryOptions<
				Schema,
				Relations,
				RelationTargetCollection<
					NonNullable<Relations[Collection]>[RelationName]
				> &
					CollectionName<Schema>
			>
}

export type RelationalQueryOptions<
	Schema extends AnySchema,
	Relations extends RuntimeRelationsDefinition<Schema>,
	Collection extends CollectionName<Schema>,
> = {
	readonly select?: RelationalSelectOptions<Schema, Collection>
	readonly where?: RelationalWhereOptions<Schema, Collection>
	readonly with?: RelationalWithOptions<Schema, Relations, Collection>
	readonly orderBy?: RelationalOrderByOptions<Schema, Collection>
	readonly limit?: number
	readonly offset?: number
}

type _RelationalQueryTestSchema = {
	users: { id: string; name: string }
	threads: { id: string; ownerId: string; title: string; status: string }
	messages: { id: string; threadId: string; body: string; createdAt: number }
}

type _RelationalQueryTestRelations = {
	readonly threads: {
		readonly owner: NormalizedManyToOneRelationDefinition<
			_RelationalQueryTestSchema,
			"threads",
			"users",
			"owner"
		>
		readonly messages: NormalizedOneToManyRelationDefinition<
			_RelationalQueryTestSchema,
			"threads",
			"messages",
			"messages"
		>
	}
	readonly messages: {
		readonly thread: NormalizedManyToOneRelationDefinition<
			_RelationalQueryTestSchema,
			"messages",
			"threads",
			"thread"
		>
	}
}

type _ThreadQueryOptions = RelationalQueryOptions<
	_RelationalQueryTestSchema,
	_RelationalQueryTestRelations,
	"threads"
>

type _AssertExtends<_A extends _B, _B> = void

type _TestRelationalSelectFields = _AssertExtends<
	keyof NonNullable<_ThreadQueryOptions["select"]>,
	"id" | "ownerId" | "title" | "status"
>
type _TestRelationalSelectFieldsReverse = _AssertExtends<
	"id" | "ownerId" | "title" | "status",
	keyof NonNullable<_ThreadQueryOptions["select"]>
>
type _TestRelationalWhereValue = _AssertExtends<
	NonNullable<_ThreadQueryOptions["where"]>["status"],
	string | FieldWhereOperators<string> | undefined
>
type _TestRelationalWhereValueReverse = _AssertExtends<
	string | FieldWhereOperators<string> | undefined,
	NonNullable<_ThreadQueryOptions["where"]>["status"]
>
type _TestRelationalOrderByValue = _AssertExtends<
	NonNullable<_ThreadQueryOptions["orderBy"]>["title"],
	"asc" | "desc" | undefined
>
type _TestRelationalOrderByValueReverse = _AssertExtends<
	"asc" | "desc" | undefined,
	NonNullable<_ThreadQueryOptions["orderBy"]>["title"]
>
type _TestRelationalWithRelations = _AssertExtends<
	keyof NonNullable<_ThreadQueryOptions["with"]>,
	"owner" | "messages"
>
type _TestRelationalWithRelationsReverse = _AssertExtends<
	"owner" | "messages",
	keyof NonNullable<_ThreadQueryOptions["with"]>
>

type _OwnerQueryOptions = Exclude<
	NonNullable<_ThreadQueryOptions["with"]>["owner"],
	true | undefined
>
type _TestNestedWithScopesToTargetCollection = _AssertExtends<
	keyof NonNullable<_OwnerQueryOptions["select"]>,
	"id" | "name"
>
type _TestNestedWithScopesToTargetCollectionReverse = _AssertExtends<
	"id" | "name",
	keyof NonNullable<_OwnerQueryOptions["select"]>
>

// @ts-expect-error Root collections must exist on the schema
type _TestRelationalInvalidCollection = RelationalQueryOptions<_RelationalQueryTestSchema, _RelationalQueryTestRelations, "missing">

// @ts-expect-error Selected fields must exist on the current collection
type _TestRelationalInvalidSelectField = NonNullable<_ThreadQueryOptions["select"]>["missingField"]

// @ts-expect-error Where fields must exist on the current collection
type _TestRelationalInvalidWhereField = NonNullable<_ThreadQueryOptions["where"]>["missingField"]

// @ts-expect-error Where equality values must match the field type
type _TestRelationalInvalidWhereValue = _AssertExtends<123, NonNullable<_ThreadQueryOptions["where"]>["status"]>

// @ts-expect-error Order fields must exist on the current collection
type _TestRelationalInvalidOrderByField = NonNullable<_ThreadQueryOptions["orderBy"]>["missingField"]

// @ts-expect-error Order directions must be asc or desc
type _TestRelationalInvalidOrderByValue = _AssertExtends<"up", NonNullable<_ThreadQueryOptions["orderBy"]>["title"]>

// @ts-expect-error Relation names must exist on the current collection
type _TestRelationalInvalidRelation = NonNullable<_ThreadQueryOptions["with"]>["missingRelation"]

// @ts-expect-error Nested relation options are scoped to the target collection
type _TestRelationalInvalidNestedSelect = NonNullable<_OwnerQueryOptions["select"]>["title"]

export type ClientId = Tagged<"ClientId", string>
export type Cookie = Tagged<"Cookie", number | string>

export type ClientApi = {
	clientId: ClientId
	poke: () => void
}

export type ScanWindow<Schema extends AnySchema> = EncodedQuery<Schema>[]

export type RemoteApi<Schema extends AnySchema> = {
	connect(api: ClientApi): Promise<AsyncUnsubscribe>
	push(args: {
		mutations: Mutation<Schema>[]
		clientId: ClientId
	}): Promise<void>
	pull(args: {
		clientId: ClientId
		cookie?: Cookie
		scanWindow: ScanWindow<Schema>
	}): Promise<{
		cookie: Cookie
		patch: Patch<Schema>
		lastMutationId?: MutationId
	}>
}

export type RngApi = {
	randomId: () => string
}

export type TimerApi = {
	delay: (ms: number) => Promise<void>
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

export type EncodedQuery<Schema extends AnySchema> = {
	collection: keyof Schema & string
	select?: readonly (Attribute<Schema> & string)[] | "*"
	where?: [
		attribute: Attribute<Schema>,
		operator: Operator,
		operand: Attribute<Schema>,
	][]
	order?: [attribute: Attribute<Schema>, direction: "asc" | "desc"][]
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
		query: EncodedQuery<Schema>,
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
		scanWindow: ScanWindow<Schema>,
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

export namespace PatchApi {
	export function toString<Schema extends AnySchema>(
		patch: Patch<Schema>,
	): string {
		return `Patch {\n${
			patch.set
				?.map(
					(op) =>
						`  set ${op.collection}.${op.value.id} = ${JSON.stringify(op.value)}`,
				)
				.join("\n") ?? ""
		}\n${patch.remove?.map((op) => `  remove ${op.collection}.${op.id}`).join("\n") ?? ""}}`
	}

	export function toWriteOps<Schema extends AnySchema>(
		patch: Patch<Schema>,
	): WriteOps {
		const set: WriteOps["set"] = []
		const remove: WriteOps["remove"] = []

		for (const s of patch.set ?? []) {
			const key = ["record", s.collection, s.value.id]
			set!.push({ key, value: s.value })
		}

		for (const r of patch.remove ?? []) {
			remove!.push(["record", r.collection, r.id])
		}

		return { set, remove }
	}
}

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

export type Json =
	| string
	| number
	| boolean
	| null
	| Json[]
	| { [key: string]: Json }

export type PatchSetOp<Schema extends AnySchema> = {
	[Collection in CollectionName<Schema>]: {
		collection: Collection
		value: Schema[Collection]
	}
}[CollectionName<Schema>]

export type PatchRemoveOp<Schema extends AnySchema> = {
	[Collection in CollectionName<Schema>]: {
		collection: Collection
		id: Schema[Collection]["id"]
	}
}[CollectionName<Schema>]

export type Patch<Schema extends AnySchema = AnySchema> = {
	set?: PatchSetOp<Schema>[]
	remove?: PatchRemoveOp<Schema>[]
}
