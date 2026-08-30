import type {
	AnySchema,
	CollectionName,
	EncodedQuery,
	EncodedWhereClause,
} from "@get-halo/tandem-types"

function compareValues(
	fieldValue: unknown,
	operator: string,
	comparisonValue: unknown,
): boolean {
	switch (operator) {
		case "=":
			return Object.is(fieldValue, comparisonValue)
		case ">":
			return (fieldValue as any) > (comparisonValue as any)
		case "<":
			return (fieldValue as any) < (comparisonValue as any)
		case ">=":
			return (fieldValue as any) >= (comparisonValue as any)
		case "<=":
			return (fieldValue as any) <= (comparisonValue as any)
		default:
			throw new Error(`Unknown where operator "${operator}"`)
	}
}

export function matchesWhere<
	Schema extends AnySchema,
	Collection extends CollectionName<Schema>,
>(
	record: Schema[Collection],
	where: EncodedWhereClause<Schema, Collection>[] | undefined,
): boolean {
	return (where ?? []).every(([field, operator, value]) =>
		compareValues(record[field], operator, value),
	)
}

export function compareByOrder<Schema extends AnySchema>(
	order: NonNullable<EncodedQuery<Schema>["order"]>,
) {
	return (
		left: Schema[CollectionName<Schema>],
		right: Schema[CollectionName<Schema>],
	) => {
		for (const [field, direction] of order) {
			const leftValue = left[field]
			const rightValue = right[field]
			if (Object.is(leftValue, rightValue)) continue

			const result = leftValue > rightValue ? 1 : -1
			return direction === "asc" ? result : -result
		}

		return 0
	}
}
