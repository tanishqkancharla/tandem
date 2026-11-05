import { CompiledQuery, type Kysely } from "kysely"
import type {
	TandemSqlRow,
	TandemSqlStatement,
} from "./TandemServerSqlStorage.js"

export function kyselyToTandemSqlExecution(database: Kysely<unknown>) {
	return {
		query: async ({ sql, parameters }: TandemSqlStatement) =>
			(
				await database.executeQuery<TandemSqlRow>(
					CompiledQuery.raw(sql, [...parameters]),
				)
			).rows,
		commit: async (statements: readonly TandemSqlStatement[]) => {
			await database.transaction().execute(async (transaction) => {
				for (const { sql, parameters } of statements)
					await transaction.executeQuery(
						CompiledQuery.raw(sql, [...parameters]),
					)
			})
		},
	}
}
