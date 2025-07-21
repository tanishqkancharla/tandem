import {
	AnySchema,
	Attribute,
	CollectionName,
	EncodedQuery,
	Operator,
} from "@tandem/types"

export class QueryBuilder<
	Schema extends AnySchema,
	Collection extends CollectionName<Schema>,
> {
	private constructor(
		private readonly encodedQuery: Readonly<EncodedQuery<Schema>>,
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

	where<A extends Attribute<Schema>>(
		attribute: A,
		operator: Operator,
		value: any,
	): QueryBuilder<Schema, Collection> {
		const existingClauses = this.encodedQuery.where ?? []

		return new QueryBuilder({
			...this.encodedQuery,
			where: [...existingClauses, [attribute, operator, value]],
		})
	}

	order(
		attribute: Attribute<Schema>,
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

	build(): Readonly<EncodedQuery<Schema>> {
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
