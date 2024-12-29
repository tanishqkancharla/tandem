import {
	AnyCollectionSchema,
	AnySchema,
	Attribute,
	CollectionName,
	EncodedQuery,
	Operator,
} from "./types"

export class QueryBuilder<
	Schema extends AnySchema,
	CollectionSchema extends Schema[keyof Schema] & AnyCollectionSchema,
> {
	private constructor(private readonly encodedQuery: Readonly<EncodedQuery>) {}

	select(
		attributes: readonly (keyof CollectionSchema & string)[] | "*",
	): QueryBuilder<Schema, CollectionSchema> {
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

	where<A extends Attribute<CollectionSchema>>(
		attribute: A,
		operator: Operator,
		value: CollectionSchema[A],
	): QueryBuilder<Schema, CollectionSchema> {
		const existingClauses = this.encodedQuery.where ?? []

		return new QueryBuilder({
			...this.encodedQuery,
			where: [...existingClauses, [attribute, operator, value]],
		})
	}

	order(
		attribute: Attribute<CollectionSchema>,
		direction: "asc" | "desc",
	): QueryBuilder<Schema, CollectionSchema> {
		const existingClauses = this.encodedQuery.order ?? []

		return new QueryBuilder({
			...this.encodedQuery,
			order: [...existingClauses, [attribute, direction]],
		})
	}

	limit(limit: number): QueryBuilder<Schema, CollectionSchema> {
		// TODO: what happens if limit is already defined?
		return new QueryBuilder({ ...this.encodedQuery, limit })
	}

	id(id: string | number): QueryBuilder<Schema, CollectionSchema> {
		return this.where("id", "=", id).one()
	}

	one(): QueryBuilder<Schema, CollectionSchema> {
		return this.limit(1)
	}

	build(): Readonly<EncodedQuery> {
		return this.encodedQuery
	}

	static new<
		Schema extends AnySchema,
		Collection extends CollectionName<Schema>,
	>(collection: Collection): QueryBuilder<Schema, Schema[Collection]> {
		return new QueryBuilder<Schema, Schema[Collection]>({ collection })
	}

	// join() {}
}

export type QueryResults<Query extends QueryBuilder<any, any>> =
	// TODO: account for select
	Query extends QueryBuilder<any, infer Collection> ? Collection[] : never

export function q<
	Schema extends AnySchema,
	Collection extends CollectionName<Schema>,
>(collection: Collection) {
	return QueryBuilder.new<Schema, Collection>(collection)
}
