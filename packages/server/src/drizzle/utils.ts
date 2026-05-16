import { and, asc, desc, eq, gt, gte, lt, lte } from "drizzle-orm"
import type { AnyColumn, SQL } from "drizzle-orm"
import type {
	AnySchema,
	CollectionName,
	EncodedWhereClause,
} from "@tandem/types"

export type DrizzleTableWithId<Column extends AnyColumn> = {
	id: Column
} & Record<string, Column>

export function buildWhere<
	Schema extends AnySchema,
	Collection extends CollectionName<Schema>,
>(
	table: DrizzleTableWithId<AnyColumn>,
	where: EncodedWhereClause<Schema, Collection>[] | undefined,
): SQL | undefined {
	const clauses = (where ?? []).map(([field, operator, value]) => {
		const column = table[field]
		switch (operator) {
			case "=":
				return eq(column, value)
			case ">":
				return gt(column, value)
			case "<":
				return lt(column, value)
			case ">=":
				return gte(column, value)
			case "<=":
				return lte(column, value)
		}
	})

	if (clauses.length === 0) return undefined
	if (clauses.length === 1) return clauses[0]
	return and(...clauses)
}

export function buildOrderBy(
	table: DrizzleTableWithId<AnyColumn>,
	order: [field: string, direction: "asc" | "desc"][] | undefined,
): SQL[] {
	return (order ?? []).map(([field, direction]) =>
		direction === "asc" ? asc(table[field]) : desc(table[field]),
	)
}
