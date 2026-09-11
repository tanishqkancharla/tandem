import type {
	AnySchema,
	Attribute,
	CollectionName,
	AnyRelations,
} from "../schema/Schema"

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

export type ScanWindow<Schema extends AnySchema> = EncodedQuery<Schema>[]

const whereOperatorMap = {
	eq: "=",
	gt: ">",
	lt: "<",
	gte: ">=",
	lte: "<=",
} as const satisfies Record<string, Operator>

function isWhereOperatorObject(
	value: unknown,
): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value)
}

export function _encodeRelationalQuery<
	Schema extends AnySchema,
	Relations extends AnyRelations<Schema>,
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

					encoded.where.push([field, encodedOperator, value] as NonNullable<
						EncodedQuery<Schema, Collection>["where"]
					>[number])
				}
			} else {
				encoded.where.push([field, "=", condition] as NonNullable<
					EncodedQuery<Schema, Collection>["where"]
				>[number])
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
			throw new Error(
				"Cannot encode relational query includes without relations",
			)
		}

		encoded.with = {}
		const collectionRelations = relations[collection]
		for (const [relationName, relationOptions] of Object.entries(
			options.with,
		)) {
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
