import type {
	AnySchema,
	RuntimeSchemaDefinition,
} from "@tanishqkancharla/tandem-core"
import { TandemServerSqlStorage } from "./TandemServerSqlStorage.js"

/** The D1 capabilities used by Tandem; accepts a Cloudflare D1 binding. */
export interface TandemD1Database {
	prepare(sql: string): TandemD1Statement
	batch(statements: TandemD1Statement[]): Promise<unknown>
}

export interface TandemD1Statement {
	bind(...parameters: unknown[]): TandemD1Statement
	all(): Promise<{ results: Record<string, unknown>[] }>
}

/** Maps schema names directly to existing D1 tables and columns. */
export class TandemServerD1Storage<
	Schema extends AnySchema,
> extends TandemServerSqlStorage<Schema> {
	constructor(args: {
		schema: RuntimeSchemaDefinition<Schema>
		database: TandemD1Database
	}) {
		super({
			schema: args.schema,
			dialect: "sqlite",
			query: async ({ sql, parameters }) =>
				(
					await args.database
						.prepare(sql)
						.bind(...parameters)
						.all()
				).results,
			commit: async (statements) => {
				await args.database.batch(
					statements.map(({ sql, parameters }) =>
						args.database.prepare(sql).bind(...parameters),
					),
				)
			},
		})
	}
}
