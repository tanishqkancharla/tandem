import type {
	AnySchema,
	RuntimeSchemaDefinition,
} from "@tanishqkancharla/tandem-core"
import { Kysely, PostgresDialect, type PostgresPool } from "kysely"
import { kyselyToTandemSqlExecution } from "./kyselyToTandemSqlExecution.js"
import { TandemServerSqlStorage } from "./TandemServerSqlStorage.js"

/** Borrows a node-postgres Pool; the application closes the pool. */
export class TandemServerPostgresStorage<
	Schema extends AnySchema,
> extends TandemServerSqlStorage<Schema> {
	constructor(args: {
		schema: RuntimeSchemaDefinition<Schema>
		database: PostgresPool
	}) {
		const database = new Kysely<unknown>({
			dialect: new PostgresDialect({ pool: args.database }),
		})
		super({
			schema: args.schema,
			dialect: "postgres",
			...kyselyToTandemSqlExecution(database),
		})
	}
}
