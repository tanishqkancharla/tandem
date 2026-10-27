import type { PartialObjectCodec } from "../utils/Codec.js"
import type {
	AnySchema,
	CollectionName,
	RuntimeSchemaDefinition,
} from "./Schema.js"

/**
 * A collection's effective record codec. Partial-object codecs transform whole
 * records and the payloads of `update` operations with the same shape.
 */
export type CollectionCodecs<Schema extends AnySchema> = {
	readonly [Collection in CollectionName<Schema>]?: PartialObjectCodec<
		Schema[Collection],
		never
	>
}

export function getSchemaCodecs<Schema extends AnySchema>(
	schema: RuntimeSchemaDefinition<Schema> | undefined,
): CollectionCodecs<Schema> {
	return Object.fromEntries(
		Object.entries(schema?.collections ?? {})
			.filter(([, collection]) => collection.codec)
			.map(([name, collection]) => [name, collection.codec]),
	) as CollectionCodecs<Schema>
}
