import type {
	AnySchema,
	RuntimeSchemaDefinition,
} from "@tanishqkancharla/tandem-core"

/**
 * Browser-safe Drizzle → Tandem schema bridge.
 *
 * Author tables once with drizzle-orm/sqlite-core, pass the same objects to
 * a server adapter, and derive client schema metadata from those tables.
 * Declaring tables does not create them. This module must not import native
 * database drivers or Node connection code.
 *
 * Record types come from Drizzle `$inferSelect`, including nullability and
 * JS property names when they differ from SQL column names. Each table must
 * have an `id` primary key. Unsupported column types fail at setup rather
 * than coercing silently.
 *
 * `set` writes the record the caller provided. Database defaults and
 * generated columns are not filled in by Tandem unless the storage adapter
 * materializes the saved row after insert.
 */
export type DrizzleTableLike = {
	readonly $inferSelect: Record<string, unknown> & { id: string | number }
}

export type SchemaFromDrizzleTables<
	Tables extends Record<string, DrizzleTableLike>,
> = {
	[Name in keyof Tables & string]: Tables[Name]["$inferSelect"]
}

export function deriveTandemSchema<
	const Tables extends Record<string, DrizzleTableLike>,
>(
	_tables: Tables,
): SchemaFromDrizzleTables<Tables> extends AnySchema
	? RuntimeSchemaDefinition<SchemaFromDrizzleTables<Tables>>
	: never {
	throw new Error("deriveTandemSchema is not implemented")
}
