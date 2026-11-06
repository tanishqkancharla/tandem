import { PGlite } from "@electric-sql/pglite"
import * as errore from "errore"
import { Miniflare } from "miniflare"
import { DatabaseSync } from "node:sqlite"
import pg from "pg"
import type {
	TandemSqlDialect,
	TandemSqlRow,
	TandemSqlStatement,
} from "../src/sql.js"

/** A real SQL database with the host functions TandemServerSqlStorage takes. */
export type SqlDatabase = {
	name: string
	dialect: TandemSqlDialect
	query: (statement: TandemSqlStatement) => Promise<TandemSqlRow[]>
	commit: (statements: readonly TandemSqlStatement[]) => Promise<void>
	/** Runs DDL or setup SQL outside Tandem. */
	exec: (sql: string) => Promise<void>
	close: () => Promise<void>
}

export type SqlDatabaseName = "sqlite" | "d1" | "pglite" | "postgres"

/** Postgres runs only when TANDEM_POSTGRES_URL names an isolated database. */
export const sqlDatabaseNames: SqlDatabaseName[] = [
	"sqlite",
	"d1",
	"pglite",
	...(process.env.TANDEM_POSTGRES_URL ? (["postgres"] as const) : []),
]

export async function openSqlDatabase(
	name: SqlDatabaseName,
): Promise<SqlDatabase> {
	if (name === "sqlite") {
		const db = new DatabaseSync(":memory:")
		const run = ({ sql, parameters }: TandemSqlStatement) =>
			db.prepare(sql).all(...(parameters as never[])) as TandemSqlRow[]
		return {
			name,
			dialect: "sqlite",
			query: async (statement) => run(statement),
			commit: async (statements) => {
				db.exec("begin")
				const ran = errore.try(() => statements.forEach(run))
				if (ran instanceof Error) {
					db.exec("rollback")
					throw ran
				}
				db.exec("commit")
			},
			exec: async (sql) => db.exec(sql),
			close: async () => db.close(),
		}
	}
	if (name === "d1") {
		const runtime = new Miniflare({
			modules: true,
			script: "export default {fetch() {return new Response('ok')}}",
			compatibilityDate: "2026-07-01",
			d1Databases: { DB: `pushdown-${crypto.randomUUID()}` },
		})
		const db = await runtime.getD1Database("DB")
		return {
			name,
			dialect: "sqlite",
			query: async ({ sql, parameters }) =>
				(
					await db
						.prepare(sql)
						.bind(...parameters)
						.all()
				).results as TandemSqlRow[],
			commit: async (statements) => {
				await db.batch(
					statements.map(({ sql, parameters }) =>
						db.prepare(sql).bind(...parameters),
					),
				)
			},
			exec: async (sql) => {
				await db.prepare(sql).run()
			},
			close: () => runtime.dispose(),
		}
	}
	if (name === "pglite") {
		const db = new PGlite()
		return {
			name,
			dialect: "postgres",
			query: async ({ sql, parameters }) =>
				(await db.query<TandemSqlRow>(sql, [...parameters])).rows,
			commit: async (statements) => {
				await db.transaction(async (tx) => {
					for (const { sql, parameters } of statements)
						await tx.query(sql, [...parameters])
				})
			},
			exec: async (sql) => {
				await db.exec(sql)
			},
			close: () => db.close(),
		}
	}
	const pool = new pg.Pool({
		connectionString: process.env.TANDEM_POSTGRES_URL,
	})
	// Each database gets its own schema, so runs never share tables.
	const schema = `pushdown_${crypto.randomUUID().replaceAll("-", "")}`
	await pool.query(`create schema ${schema}`)
	const client = await pool.connect()
	await client.query(`set search_path to ${schema}`)
	return {
		name,
		dialect: "postgres",
		query: async ({ sql, parameters }) =>
			(await client.query(sql, [...parameters])).rows,
		commit: async (statements) => {
			await client.query("begin")
			for (const { sql, parameters } of statements) {
				const ran = await client
					.query(sql, [...parameters])
					.then(() => undefined)
					.catch((cause: unknown) => cause)
				if (ran !== undefined) {
					await client.query("rollback")
					throw ran
				}
			}
			await client.query("commit")
		},
		exec: async (sql) => {
			await client.query(sql)
		},
		close: async () => {
			await client.query(`drop schema ${schema} cascade`)
			client.release()
			await pool.end()
		},
	}
}
