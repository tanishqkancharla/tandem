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

type RelationTypeForResult<Relation> = Relation extends {
	readonly type: infer Type
}
	? Type
	: never

export type RelationalWithOptions<
	Schema extends AnySchema,
	Relations extends RuntimeRelationsDefinition<Schema>,
	Collection extends CollectionName<Schema>,
> = {
	readonly [RelationName in keyof NonNullable<Relations[Collection]> &
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

export type RelationalQuery<
	Schema extends AnySchema,
	Relations extends RuntimeRelationsDefinition<Schema>,
	Collection extends CollectionName<Schema> = CollectionName<Schema>,
> =
	Collection extends CollectionName<Schema>
		? {
				readonly collection: Collection
			} & RelationalQueryOptions<Schema, Relations, Collection>
		: never

type SelectedScalarKeys<
	Schema extends AnySchema,
	Collection extends CollectionName<Schema>,
	Select,
> = keyof {
	readonly [Field in keyof Schema[Collection] & string as Select extends {
		readonly [Key in Field]?: true
	}
		? Field
		: never]: true
}

export type RelationalQueryRow<
	Schema extends AnySchema,
	Relations extends RuntimeRelationsDefinition<Schema>,
	Collection extends CollectionName<Schema>,
	Options extends RelationalQueryOptions<Schema, Relations, Collection> = {},
> = RelationalQueryScalars<Schema, Collection, Options> &
	RelationalQueryIncludedRelations<Schema, Relations, Collection, Options>

type RelationalQueryScalars<
	Schema extends AnySchema,
	Collection extends CollectionName<Schema>,
	Options extends {
		readonly select?: RelationalSelectOptions<Schema, Collection>
	},
> = Options extends { readonly select: infer Select }
	? Pick<
			Schema[Collection],
			SelectedScalarKeys<Schema, Collection, Select> & keyof Schema[Collection]
		>
	: Schema[Collection]

type RelationalQueryIncludedRelations<
	Schema extends AnySchema,
	Relations extends RuntimeRelationsDefinition<Schema>,
	Collection extends CollectionName<Schema>,
	Options extends RelationalQueryOptions<Schema, Relations, Collection>,
> = Options extends { readonly with: infer With }
	? {
			readonly [RelationName in keyof With &
				keyof NonNullable<Relations[Collection]> &
				string]: RelationalIncludedRelationResult<
				Schema,
				Relations,
				NonNullable<Relations[Collection]>[RelationName],
				With[RelationName]
			>
		}
	: {}

type RelationalIncludedRelationResult<
	Schema extends AnySchema,
	Relations extends RuntimeRelationsDefinition<Schema>,
	Relation,
	Include,
> =
	RelationTargetCollection<Relation> extends CollectionName<Schema>
		? RelationTypeForResult<Relation> extends "many-to-one"
			? RelationalQueryRow<
					Schema,
					Relations,
					RelationTargetCollection<Relation> & CollectionName<Schema>,
					RelationalIncludedRelationOptions<
						Schema,
						Relations,
						RelationTargetCollection<Relation> & CollectionName<Schema>,
						Include
					>
				> | null
			: RelationTypeForResult<Relation> extends "one-to-many"
				? RelationalQueryRow<
						Schema,
						Relations,
						RelationTargetCollection<Relation> & CollectionName<Schema>,
						RelationalIncludedRelationOptions<
							Schema,
							Relations,
							RelationTargetCollection<Relation> & CollectionName<Schema>,
							Include
						>
					>[]
				: never
		: never

type RelationalIncludedRelationOptions<
	Schema extends AnySchema,
	Relations extends RuntimeRelationsDefinition<Schema>,
	Collection extends CollectionName<Schema>,
	Include,
> = Include extends true
	? {}
	: Include extends RelationalQueryOptions<Schema, Relations, Collection>
		? Include
		: never

type RelationalQueryResultForOptions<
	Schema extends AnySchema,
	Relations extends RuntimeRelationsDefinition<Schema>,
	Collection extends CollectionName<Schema>,
	Options extends RelationalQueryOptions<Schema, Relations, Collection> = {},
> = RelationalQueryRow<Schema, Relations, Collection, Options>[]

export type RelationalQueryResult<
	Schema extends AnySchema,
	Relations extends RuntimeRelationsDefinition<Schema>,
	Query extends RelationalQuery<Schema, Relations>,
> = RelationalQueryResultForOptions<
	Schema,
	Relations,
	Query["collection"] & CollectionName<Schema>,
	Query
>

type _RelationalQueryTestSchema = {
	users: { id: string; name: string }
	threads: { id: string; ownerId: string; title: string; status: string }
	messages: { id: string; threadId: string; body: string; createdAt: number }
	profiles: { id: string; userId: string; displayName: string }
}

type _RelationalQueryTestRelations = {
	threads: {
		owner: NormalizedManyToOneRelationDefinition<
			_RelationalQueryTestSchema,
			"threads",
			"users",
			"owner"
		>
		messages: NormalizedOneToManyRelationDefinition<
			_RelationalQueryTestSchema,
			"threads",
			"messages",
			"messages"
		>
	}
	messages: {
		thread: NormalizedManyToOneRelationDefinition<
			_RelationalQueryTestSchema,
			"messages",
			"threads",
			"thread"
		>
	}
	users: {
		profile: NormalizedManyToOneRelationDefinition<
			_RelationalQueryTestSchema,
			"users",
			"profiles",
			"profile"
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

type _TestRelationalInvalidCollection = RelationalQueryOptions<
	_RelationalQueryTestSchema,
	_RelationalQueryTestRelations,
	// @ts-expect-error Root collections must exist on the schema
	"missing"
>

type _TestRelationalInvalidSelectField = NonNullable<
	_ThreadQueryOptions["select"]
	// @ts-expect-error Selected fields must exist on the current collection
>["missingField"]

type _TestRelationalInvalidWhereField = NonNullable<
	_ThreadQueryOptions["where"]
	// @ts-expect-error Where fields must exist on the current collection
>["missingField"]

type _TestRelationalInvalidWhereValue = _AssertExtends<
	// @ts-expect-error Where equality values must match the field type
	123,
	NonNullable<_ThreadQueryOptions["where"]>["status"]
>

type _TestRelationalInvalidOrderByField = NonNullable<
	_ThreadQueryOptions["orderBy"]
	// @ts-expect-error Order fields must exist on the current collection
>["missingField"]

type _TestRelationalInvalidOrderByValue = _AssertExtends<
	// @ts-expect-error Order directions must be asc or desc
	"up",
	NonNullable<_ThreadQueryOptions["orderBy"]>["title"]
>

type _TestRelationalInvalidRelation = NonNullable<
	_ThreadQueryOptions["with"]
	// @ts-expect-error Relation names must exist on the current collection
>["missingRelation"]

type _TestRelationalInvalidNestedSelect = NonNullable<
	_OwnerQueryOptions["select"]
	// @ts-expect-error Nested relation options are scoped to the target collection
>["title"]

type _TestRelationalOmittedSelectResult = Assert<
	TestIsEqual<
		RelationalQueryResult<
			_RelationalQueryTestSchema,
			_RelationalQueryTestRelations,
			{ collection: "threads" }
		>,
		_RelationalQueryTestSchema["threads"][]
	>
>
type _TestRelationalSingleSelectResult = Assert<
	TestIsEqual<
		RelationalQueryResult<
			_RelationalQueryTestSchema,
			_RelationalQueryTestRelations,
			{ collection: "threads"; select: { id: true } }
		>,
		{ id: string }[]
	>
>
type _TestRelationalMultiSelectResult = Assert<
	TestIsEqual<
		RelationalQueryResult<
			_RelationalQueryTestSchema,
			_RelationalQueryTestRelations,
			{ collection: "threads"; select: { id: true; title: true } }
		>,
		{ id: string; title: string }[]
	>
>

type _TestRelationalInvalidSelectValue = RelationalQueryResult<
	_RelationalQueryTestSchema,
	_RelationalQueryTestRelations,
	// @ts-expect-error Select values must be true
	{
		collection: "threads"
		select: {
			id: false
		}
	}
>

type _TestRelationalManyToOneResult = Assert<
	TestIsEqual<
		RelationalQueryResult<
			_RelationalQueryTestSchema,
			_RelationalQueryTestRelations,
			{
				collection: "threads"
				select: { id: true }
				with: { owner: { select: { name: true } } }
			}
		>,
		{ id: string; readonly owner: { name: string } | null }[]
	>
>
type _TestRelationalOneToManyResult = Assert<
	TestIsEqual<
		RelationalQueryResult<
			_RelationalQueryTestSchema,
			_RelationalQueryTestRelations,
			{
				collection: "threads"
				select: { id: true }
				with: { messages: { select: { body: true } } }
			}
		>,
		{ id: string; readonly messages: { body: string }[] }[]
	>
>
type _TestRelationalOneToManyLimitOneResult = Assert<
	TestIsEqual<
		RelationalQueryResult<
			_RelationalQueryTestSchema,
			_RelationalQueryTestRelations,
			{
				collection: "threads"
				select: { id: true }
				with: { messages: { select: { body: true }; limit: 1 } }
			}
		>,
		{ id: string; readonly messages: { body: string }[] }[]
	>
>
type _TestRelationalTrueIncludeResult = Assert<
	TestIsEqual<
		RelationalQueryResult<
			_RelationalQueryTestSchema,
			_RelationalQueryTestRelations,
			{ collection: "threads"; select: { id: true }; with: { owner: true } }
		>,
		{ id: string; readonly owner: _RelationalQueryTestSchema["users"] | null }[]
	>
>
type _TestRelationalNestedWithResult = Assert<
	TestIsEqual<
		RelationalQueryResult<
			_RelationalQueryTestSchema,
			_RelationalQueryTestRelations,
			{
				collection: "threads"
				select: { id: true }
				with: {
					owner: {
						select: { name: true }
						with: { profile: { select: { displayName: true } } }
					}
				}
			}
		>,
		{
			id: string
			readonly owner: {
				name: string
				readonly profile: { displayName: string } | null
			} | null
		}[]
	>
>

type _TestRelationalInvalidNestedResultSelect = RelationalQueryResult<
	_RelationalQueryTestSchema,
	_RelationalQueryTestRelations,
	// @ts-expect-error Nested selected fields must exist on the relation target collection
	{
		collection: "threads"
		with: {
			owner: {
				select: {
					title: true
				}
			}
		}
	}
>

type _TestRelationalInvalidNestedResultRelation = RelationalQueryResult<
	_RelationalQueryTestSchema,
	_RelationalQueryTestRelations,
	// @ts-expect-error Nested relation names must exist on the relation target collection
	{
		collection: "threads"
		with: {
			owner: {
				with: {
					messages: true
				}
			}
		}
	}
>

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

export type EncodedWhereClause<
	Schema extends AnySchema,
	Collection extends CollectionName<Schema>,
> = {
	[Field in keyof Schema[Collection] & string]: [
		attribute: Field,
		operator: Operator,
		value: Schema[Collection][Field],
	]
}[keyof Schema[Collection] & string]

export type EncodedQuery<
	Schema extends AnySchema,
	Collection extends CollectionName<Schema> = CollectionName<Schema>,
> = {
	collection: Collection
	select?: readonly (keyof Schema[Collection] & string)[] | "*"
	where?: EncodedWhereClause<Schema, Collection>[]
	order?: [
		attribute: keyof Schema[Collection] & string,
		direction: "asc" | "desc",
	][]
	limit?: number
	offset?: number
	with?: Record<string, EncodedQuery<Schema>>
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
