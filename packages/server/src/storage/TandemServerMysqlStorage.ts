import type {
	AnySchema,
	RuntimeSchemaDefinition,
} from "@tanishqkancharla/tandem-core"
import { Kysely, MysqlDialect, type MysqlPool } from "kysely"
import { kyselyToTandemSqlExecution } from "./kyselyToTandemSqlExecution.js"
import { TandemServerSqlStorage } from "./TandemServerSqlStorage.js"

/** Borrows a mysql2 callback Pool; the application closes the pool. */
export class TandemServerMysqlStorage<
	Schema extends AnySchema,
> extends TandemServerSqlStorage<Schema> {
	constructor(args: {
		schema: RuntimeSchemaDefinition<Schema>
		database: MysqlPool
	}) {
		const database = new Kysely<unknown>({
			dialect: new MysqlDialect({ pool: args.database }),
		})
		super({
			schema: args.schema,
			dialect: "mysql",
			...kyselyToTandemSqlExecution(database),
		})
	}
}
