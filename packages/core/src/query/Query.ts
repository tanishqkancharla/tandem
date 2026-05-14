import {
	AnySchema,
	Attribute,
	CollectionName,
	EncodedQuery,
	Operator,
	RelationalQueryOptions,
	RuntimeRelationsDefinition,
} from "@tandem/types"

const whereOperatorMap = {
	eq: "=",
	gt: ">",
	lt: "<",
	gte: ">=",
	lte: "<=",
} as const satisfies Record<string, Operator>

function isWhereOperatorObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value)
}

export function _encodeRelationalQuery<
	Schema extends AnySchema,
	Relations extends RuntimeRelationsDefinition<Schema>,
	Collection extends CollectionName<Schema>,
>(
	collection: Collection,
	options: RelationalQueryOptions<Schema, Relations, Collection> = {},
	relations?: Relations,
): EncodedQuery<Schema> {
	const encoded: EncodedQuery<Schema> = { collection }

	if (options.select) {
		encoded.select = Object.keys(options.select) as Attribute<Schema>[]
	}

	if (options.where) {
		encoded.where = []
		for (const [field, condition] of Object.entries(options.where)) {
			if (isWhereOperatorObject(condition)) {
				for (const [operator, value] of Object.entries(condition)) {
					const encodedOperator =
						whereOperatorMap[operator as keyof typeof whereOperatorMap]
					if (!encodedOperator) {
						throw new Error(`Unknown where operator "${operator}"`)
					}

					encoded.where.push([
						field,
						encodedOperator,
						value,
					] as NonNullable<EncodedQuery<Schema, Collection>["where"]>[number])
				}
			} else {
				encoded.where.push([
					field,
					"=",
					condition,
				] as NonNullable<EncodedQuery<Schema, Collection>["where"]>[number])
			}
		}
	}

	if (options.orderBy) {
		encoded.order = []
		for (const [field, direction] of Object.entries(options.orderBy)) {
			if (!direction) continue

			encoded.order.push([field, direction] as NonNullable<
				EncodedQuery<Schema, Collection>["order"]
			>[number])
		}
	}

	if (options.limit !== undefined) {
		encoded.limit = options.limit
	}

	if (options.offset !== undefined) {
		encoded.offset = options.offset
	}

	if (options.with) {
		if (!relations) {
			throw new Error("Cannot encode relational query includes without relations")
		}

		encoded.with = {}
		const collectionRelations = relations[collection]
		for (const [relationName, relationOptions] of Object.entries(options.with)) {
			const relation = collectionRelations?.[relationName]
			if (!relation) {
				throw new Error(`Unknown relation "${collection}.${relationName}"`)
			}

			encoded.with[relationName] = _encodeRelationalQuery(
				relation.targetCollection,
				relationOptions === true ? {} : (relationOptions as any),
				relations,
			)
		}
	}

	return encoded
}
