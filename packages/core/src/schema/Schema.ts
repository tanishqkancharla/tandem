import type {
	AnyCollectionDefinition,
	AnyCollectionSchema,
	AnyRuntimeFieldDefinition,
	AnySchema,
	CollectionName,
	CollectionDefinition,
	NormalizedManyToOneRelationDefinition,
	NormalizedOneToManyRelationDefinition,
	NormalizedRelationDefinition,
	RelationType,
	RuntimeFieldDefinition,
	RuntimeSchemaDefinition,
} from "@tandem/types"
import type { Codec } from "../utils/Codec"

type CollectionOptions<Record extends AnyCollectionSchema, StorageValue> = {
	codec?: Codec<Record, StorageValue>
	fields?: readonly (keyof Record & string)[]
}

type CollectionShape = Record<string, AnyRuntimeFieldDefinition> & {
	id: RuntimeFieldDefinition<string | number>
}

type RecordFromShape<Shape extends CollectionShape> = {
	[Field in keyof Shape & string]: Shape[Field] extends RuntimeFieldDefinition<
		infer Value
	>
		? Value
		: never
} & {
	id: string | number
}

type SchemaFromCollections<
	Collections extends Record<string, AnyCollectionDefinition>,
> = {
	[Name in keyof Collections &
		string]: Collections[Name] extends CollectionDefinition<infer Record, any>
		? Record
		: never
}

type NamedCollections<
	Collections extends Record<string, AnyCollectionDefinition>,
> = {
	readonly [Name in keyof Collections &
		string]: Collections[Name] extends CollectionDefinition<
		infer Record,
		infer CollectionCodec
	>
		? CollectionDefinition<Record, CollectionCodec> & { readonly name: Name }
		: never
}

function field<Value>(type: string): RuntimeFieldDefinition<Value> {
	return {
		kind: "field",
		type,
	}
}

function isFieldDefinition(value: unknown): value is AnyRuntimeFieldDefinition {
	return (
		typeof value === "object" &&
		value !== null &&
		"kind" in value &&
		value.kind === "field"
	)
}

function isCollectionShape(value: unknown): value is CollectionShape {
	return (
		typeof value === "object" &&
		value !== null &&
		Object.values(value).every(isFieldDefinition)
	)
}

export const t = {
	id: () => field<string>("id"),
	string: () => field<string>("string"),
	number: () => field<number>("number"),
	boolean: () => field<boolean>("boolean"),
}

export function collection<
	const Shape extends CollectionShape,
	StorageValue = unknown,
>(
	shape: Shape,
	options?: { codec?: Codec<RecordFromShape<Shape>, StorageValue> },
): CollectionDefinition<RecordFromShape<Shape>, Codec<RecordFromShape<Shape>, StorageValue>>
export function collection<
	Record extends AnyCollectionSchema,
	StorageValue = unknown,
>(
	options?: CollectionOptions<Record, StorageValue>,
): CollectionDefinition<Record, Codec<Record, StorageValue>>
export function collection<
	Record extends AnyCollectionSchema,
	StorageValue = unknown,
>(
	shapeOrOptions: CollectionShape | CollectionOptions<Record, StorageValue> = {},
	options: { codec?: Codec<Record, StorageValue> } = {},
): CollectionDefinition<Record, Codec<Record, StorageValue>> {
	if (isCollectionShape(shapeOrOptions)) {
		return {
			kind: "collection",
			codec: options.codec,
			shape: shapeOrOptions,
			fields: Object.keys(shapeOrOptions) as (keyof Record & string)[],
		}
	}

	return {
		kind: "collection",
		codec: shapeOrOptions.codec,
		fields: shapeOrOptions.fields,
	}
}

export function defineSchema<
	const Collections extends Record<string, AnyCollectionDefinition>,
>(
	collections: Collections,
): RuntimeSchemaDefinition<SchemaFromCollections<Collections>> & {
	readonly collections: NamedCollections<Collections>
} {
	const namedCollections = Object.fromEntries(
		Object.entries(collections).map(([name, definition]) => [
			name,
			{
				...definition,
				name,
			},
		]),
	)

	return {
		collections: namedCollections,
	} as RuntimeSchemaDefinition<SchemaFromCollections<Collections>> & {
		readonly collections: NamedCollections<Collections>
	}
}

type RelationRegistration<
	Type extends RelationType = RelationType,
	TargetCollection extends string = string,
	From extends string = string,
	To extends string = string,
> = {
	readonly type: Type
	readonly targetCollection: TargetCollection
	readonly from: From
	readonly to: To
}

type RelationRegistrations<Schema extends AnySchema> = {
	readonly [SourceCollection in CollectionName<Schema>]?: {
		readonly [RelationName in string]?:
			| RelationRegistration<
					"many-to-one",
					CollectionName<Schema>,
					keyof Schema[SourceCollection] & string,
					"id"
				>
			| RelationRegistration<
					"one-to-many",
					CollectionName<Schema>,
					"id",
					{
						[Collection in CollectionName<Schema>]: keyof Schema[Collection]
					}[CollectionName<Schema>] &
						string
				>
	}
}

type RelationBuilderApi<Schema extends AnySchema> = {
	one: <
		const TargetCollection extends CollectionName<Schema>,
		const From extends string,
	>(
		targetCollection: TargetCollection,
		join: { readonly from: From; readonly to: "id" },
	) => RelationRegistration<"many-to-one", TargetCollection, From, "id">
	many: <
		const TargetCollection extends CollectionName<Schema>,
		const To extends keyof Schema[TargetCollection] & string,
	>(
		targetCollection: TargetCollection,
		join: { readonly from: "id"; readonly to: To },
	) => RelationRegistration<"one-to-many", TargetCollection, "id", To>
}

type NormalizeRelationRegistration<
	Schema extends AnySchema,
	SourceCollection extends CollectionName<Schema>,
	RelationName extends string,
	Relation extends RelationRegistration,
> = Relation extends RelationRegistration<
	infer Type,
	infer TargetCollection,
	any,
	any
>
	? TargetCollection extends CollectionName<Schema>
		? Type extends "many-to-one"
			? NormalizedManyToOneRelationDefinition<
					Schema,
					SourceCollection,
					TargetCollection,
					RelationName
				>
			: Type extends "one-to-many"
				? NormalizedOneToManyRelationDefinition<
						Schema,
						SourceCollection,
						TargetCollection,
						RelationName
					>
				: never
		: never
	: never

type NormalizedRelationsDefinition<
	Schema extends AnySchema,
	Relations extends RelationRegistrations<Schema>,
> = {
	readonly [SourceCollection in keyof Relations & CollectionName<Schema>]: {
		readonly [RelationName in keyof NonNullable<
			Relations[SourceCollection]
		> &
			string]: NonNullable<Relations[SourceCollection]>[RelationName] extends RelationRegistration
			? NormalizeRelationRegistration<
					Schema,
					SourceCollection,
					RelationName,
					NonNullable<Relations[SourceCollection]>[RelationName]
				>
			: never
	}
}

type MutableRuntimeRelationsDefinition<Schema extends AnySchema> = {
	[SourceCollection in CollectionName<Schema>]?: Record<
		string,
		NormalizedRelationDefinition<Schema, SourceCollection>
	>
}

function requireRuntimeFields<Schema extends AnySchema>(
	schema: RuntimeSchemaDefinition<Schema>,
	collectionName: CollectionName<Schema>,
) {
	const fields = schema.collections[collectionName].fields
	if (!fields) {
		throw new Error(
			`Cannot validate relations for collection "${collectionName}" because it has no runtime fields. Use collection<...>({ fields: [...] }).`,
		)
	}

	return new Set<string>(fields)
}

export function defineRelations<
	Schema extends AnySchema,
	const Relations extends RelationRegistrations<Schema>,
>(
	schema: RuntimeSchemaDefinition<Schema>,
	define: (builders: RelationBuilderApi<Schema>) => Relations,
): NormalizedRelationsDefinition<Schema, Relations> {
	const rawRelations = define({
		one: (targetCollection, join) => ({
			type: "many-to-one",
			targetCollection,
			from: join.from,
			to: join.to,
		}),
		many: (targetCollection, join) => ({
			type: "one-to-many",
			targetCollection,
			from: join.from,
			to: join.to,
		}),
	})

	const normalized: MutableRuntimeRelationsDefinition<Schema> = {}

	for (const [sourceCollectionName, relations] of Object.entries(
		rawRelations,
	)) {
		const sourceCollection = sourceCollectionName as CollectionName<Schema>
		if (!(sourceCollection in schema.collections)) {
			throw new Error(`Unknown source collection "${sourceCollection}"`)
		}

		const sourceFields = requireRuntimeFields(schema, sourceCollection)
		const normalizedForSource = {
			...(normalized[sourceCollection] ?? {}),
		}

		for (const [relationName, relation] of Object.entries(relations ?? {})) {
			if (!relation) continue

			const relationPath = `${sourceCollection}.${relationName}`

			if (normalizedForSource[relationName]) {
				throw new Error(`Duplicate relation "${relationPath}"`)
			}

			if (sourceFields.has(relationName)) {
				throw new Error(
					`Relation "${relationPath}" collides with field "${relationName}" on collection "${sourceCollection}"`,
				)
			}

			if (!(relation.targetCollection in schema.collections)) {
				throw new Error(
					`Unknown target collection "${relation.targetCollection}" for relation "${relationPath}"`,
				)
			}
			const targetCollection = relation.targetCollection as CollectionName<Schema>
			const targetFields = requireRuntimeFields(schema, targetCollection)

			if (!sourceFields.has(relation.from)) {
				throw new Error(
					`Missing source field "${relation.from}" for relation "${relationPath}" on collection "${sourceCollection}"`,
				)
			}

			if (relation.type === "many-to-one" && relation.to !== "id") {
				throw new Error(
					`Relation "${relationPath}" must target the related record id; expected to="id", got to="${relation.to}"`,
				)
			}

			if (relation.type === "one-to-many" && relation.from !== "id") {
				throw new Error(
					`Relation "${relationPath}" must start from the source record id; expected from="id", got from="${relation.from}"`,
				)
			}

			if (!targetFields.has(relation.to)) {
				throw new Error(
					`Missing target field "${relation.to}" for relation "${relationPath}" on collection "${targetCollection}"`,
				)
			}

			normalizedForSource[relationName] = {
				type: relation.type,
				name: relationName,
				sourceCollection,
				targetCollection: relation.targetCollection,
				from: relation.from,
				to: relation.to,
			} as NormalizedRelationDefinition<Schema>
		}

		normalized[sourceCollection] = normalizedForSource
	}

	return normalized as NormalizedRelationsDefinition<Schema, Relations>
}
