import type { AnySchema, CollectionName, AnyRelations } from "../schema/Schema"

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
	Relations extends AnyRelations<Schema>,
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
	Relations extends AnyRelations<Schema>,
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
	Relations extends AnyRelations<Schema>,
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
	Relations extends AnyRelations<Schema>,
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
	Relations extends AnyRelations<Schema>,
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
	Relations extends AnyRelations<Schema>,
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
	Relations extends AnyRelations<Schema>,
	Collection extends CollectionName<Schema>,
	Include,
> = Include extends true
	? {}
	: Include extends RelationalQueryOptions<Schema, Relations, Collection>
		? Include
		: never

type RelationalQueryResultForOptions<
	Schema extends AnySchema,
	Relations extends AnyRelations<Schema>,
	Collection extends CollectionName<Schema>,
	Options extends RelationalQueryOptions<Schema, Relations, Collection> = {},
> = RelationalQueryRow<Schema, Relations, Collection, Options>[]

export type RelationalQueryResult<
	Schema extends AnySchema,
	Relations extends AnyRelations<Schema>,
	Query extends RelationalQuery<Schema, Relations>,
> = RelationalQueryResultForOptions<
	Schema,
	Relations,
	Query["collection"] & CollectionName<Schema>,
	Query
>

export type Operator = "=" | ">" | "<" | ">=" | "<="

export type EncodedWhereClause<
	Schema extends AnySchema,
	Collection extends CollectionName<Schema>,
	Field extends keyof Schema[Collection] & string = keyof Schema[Collection] &
		string,
> = {
	[CurrentField in Field]: [
		attribute: CurrentField,
		operator: Operator,
		value: Schema[Collection][CurrentField],
	]
}[Field]

export type EncodedQuery<
	Schema extends AnySchema,
	Collection extends CollectionName<Schema> = CollectionName<Schema>,
> = {
	[CurrentCollection in Collection]: {
		collection: CurrentCollection
		select?: readonly (keyof Schema[CurrentCollection] & string)[] | "*"
		where?: EncodedWhereClause<Schema, CurrentCollection>[]
		order?: [
			attribute: keyof Schema[CurrentCollection] & string,
			direction: "asc" | "desc",
		][]
		limit?: number
		offset?: number
		with?: Record<string, EncodedQuery<Schema>>
	}
}[Collection]

export type ScanWindow<Schema extends AnySchema> = EncodedQuery<Schema>[]

function isWhereOperatorObject<Value>(
	value: Value | FieldWhereOperators<Value>,
): value is FieldWhereOperators<Value> {
	return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isFieldWhereOperator(
	operator: string,
): operator is keyof FieldWhereOperators<unknown> {
	return (
		operator === "eq" ||
		operator === "gt" ||
		operator === "lt" ||
		operator === "gte" ||
		operator === "lte"
	)
}

function encodeWhereCondition<
	Schema extends AnySchema,
	Collection extends CollectionName<Schema>,
	Field extends keyof Schema[Collection] & string,
>(
	field: Field,
	condition:
		| Schema[Collection][Field]
		| FieldWhereOperators<Schema[Collection][Field]>,
): EncodedWhereClause<Schema, Collection, Field>[] {
	if (!isWhereOperatorObject(condition)) return [[field, "=", condition]]

	for (const operator in condition) {
		if (!isFieldWhereOperator(operator)) {
			throw new Error(`Unknown where operator "${operator}"`)
		}
	}

	const clauses: EncodedWhereClause<Schema, Collection, Field>[] = []
	if (condition.eq !== undefined) clauses.push([field, "=", condition.eq])
	if (condition.gt !== undefined) clauses.push([field, ">", condition.gt])
	if (condition.lt !== undefined) clauses.push([field, "<", condition.lt])
	if (condition.gte !== undefined) clauses.push([field, ">=", condition.gte])
	if (condition.lte !== undefined) clauses.push([field, "<=", condition.lte])
	return clauses
}

export function _encodeRelationalQuery<
	Schema extends AnySchema,
	Relations extends AnyRelations<Schema>,
	Collection extends CollectionName<Schema>,
>(
	collection: Collection,
	options: RelationalQueryOptions<Schema, Relations, Collection> = {},
	relations?: Relations,
): EncodedQuery<Schema, Collection> {
	const encoded: EncodedQuery<Schema, Collection> = { collection }

	if (options.select) {
		const select: (keyof Schema[Collection] & string)[] = []
		for (const field in options.select) {
			if (options.select[field]) select.push(field)
		}
		encoded.select = select
	}

	if (options.where) {
		const where: EncodedWhereClause<Schema, Collection>[] = []
		for (const field in options.where) {
			const condition = options.where[field]
			if (condition === undefined) continue
			where.push(...encodeWhereCondition(field, condition))
		}
		encoded.where = where
	}

	if (options.orderBy) {
		const order: NonNullable<EncodedQuery<Schema, Collection>["order"]> = []
		for (const field in options.orderBy) {
			const direction = options.orderBy[field]
			if (!direction) continue

			order.push([field, direction])
		}
		encoded.order = order
	}

	if (options.limit !== undefined) {
		encoded.limit = options.limit
	}

	if (options.offset !== undefined) {
		encoded.offset = options.offset
	}

	if (options.with) {
		if (!relations) {
			throw new Error(
				"Cannot encode relational query includes without relations",
			)
		}

		const withQueries: Record<string, EncodedQuery<Schema>> = {}
		const collectionRelations = relations[collection]
		for (const relationName in options.with) {
			const relationOptions = options.with[relationName]
			if (!relationOptions) continue
			const relation = collectionRelations?.[relationName]
			if (!relation) {
				throw new Error(`Unknown relation "${collection}.${relationName}"`)
			}

			withQueries[relationName] = _encodeRelationalQuery(
				relation.targetCollection,
				relationOptions === true ? {} : relationOptions,
				relations,
			)
		}
		encoded.with = withQueries
	}

	return encoded
}
