import { customType, json, pgTable } from "drizzle-orm/pg-core"

const bytea = customType<{ data: Uint8Array; driverData: Uint8Array }>({
	dataType: () => "bytea",
})

/**
 * The table that TandemServerPostgresStorage reads and writes. Include it in
 * your Drizzle schema to create it with drizzle-kit migrations.
 */
export const tandemPostgresTuples = pgTable("tandem_tuples", {
	// Tuple keys in an encoding whose byte order matches tuple order, so the
	// primary key index serves range scans.
	key: bytea("key").primaryKey(),
	// json, unlike jsonb, keeps object key order and accepts \u0000 in strings.
	value: json("value").notNull(),
})

/** SQL that creates the table, for apps that do not use drizzle-kit. */
export const tandemPostgresTuplesSql = `CREATE TABLE IF NOT EXISTS tandem_tuples (
	key bytea PRIMARY KEY,
	value json NOT NULL
)`
