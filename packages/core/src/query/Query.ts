import {
	AnySchema,
	Attribute,
	CollectionName,
	EncodedQuery,
	Operator,
	RelationalQueryOptions,
	RuntimeRelationsDefinition,
} from "@tandem/types"

export class QueryBuilder<
	Schema extends AnySchema,
	Collection extends CollectionName<Schema>,
> {
	private constructor(
		private readonly encodedQuery: Readonly<EncodedQuery<Schema, Collection>>,
	) {}

	select(
		attributes: readonly (keyof Schema[Collection] & string)[] | "*",
	): QueryBuilder<Schema, Collection> {
		if (this.encodedQuery.select) {
			// merge
			const mergedAttributes = [
				...new Set<string>([...this.encodedQuery.select, ...attributes]),
			]

			return new QueryBuilder({
				...this.encodedQuery,
				select: mergedAttributes,
			})
		} else {
			return new QueryBuilder({
				...this.encodedQuery,
				select: attributes,
			})
		}
	}

	where<A extends keyof Schema[Collection] & string>(
		attribute: A,
		operator: Operator,
		value: Schema[Collection][A],
	): QueryBuilder<Schema, Collection> {
		const existingClauses = this.encodedQuery.where ?? []

		return new QueryBuilder({
			...this.encodedQuery,
			where: [...existingClauses, [attribute, operator, value]],
		})
	}

	order(
		attribute: keyof Schema[Collection] & string,
		direction: "asc" | "desc",
	): QueryBuilder<Schema, Collection> {
		const existingClauses = this.encodedQuery.order ?? []

		return new QueryBuilder({
			...this.encodedQuery,
			order: [...existingClauses, [attribute, direction]],
		})
	}

	limit(limit: number): QueryBuilder<Schema, Collection> {
		// TODO: what happens if limit is already defined?
		return new QueryBuilder({ ...this.encodedQuery, limit })
	}

	id(id: string | number): QueryBuilder<Schema, Collection> {
		return this.where("id", "=", id).one()
	}

	one(): QueryBuilder<Schema, Collection> {
		return this.limit(1)
	}

	build(): Readonly<EncodedQuery<Schema, Collection>> {
		return this.encodedQuery
	}

	static new<
		Schema extends AnySchema,
		Collection extends CollectionName<Schema>,
	>(collection: Collection): QueryBuilder<Schema, Collection> {
		return new QueryBuilder<Schema, Collection>({ collection })
	}

	// join() {}
}

export type QueryResults<Query extends QueryBuilder<any, any>> =
	// TODO: account for select
	Query extends QueryBuilder<infer Schema, infer Collection>
		? Schema[Collection][]
		: never

export function q<
	Schema extends AnySchema,
	Collection extends CollectionName<Schema>,
>(collection: Collection) {
	return QueryBuilder.new<Schema, Collection>(collection)
}

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

function _encodeRelationalQuery<
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
