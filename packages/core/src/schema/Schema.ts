import type {
	AnyCollectionDefinition,
	AnyCollectionSchema,
	CollectionDefinition,
	RuntimeSchemaDefinition,
} from "@tandem/types"
import type { Codec } from "../utils/Codec"

type CollectionOptions<Record extends AnyCollectionSchema, StorageValue> = {
	codec?: Codec<Record, StorageValue>
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

export function collection<
	Record extends AnyCollectionSchema,
	StorageValue = unknown,
>(
	options: CollectionOptions<Record, StorageValue> = {},
): CollectionDefinition<Record, Codec<Record, StorageValue>> {
	return {
		kind: "collection",
		codec: options.codec,
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
