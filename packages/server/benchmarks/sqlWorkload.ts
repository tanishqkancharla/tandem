/**
 * The schema, tables, indexes, seeded data, and database handles the SQL
 * benchmarks share. Data comes from a fixed seed, so every configuration and
 * database reads the same rows.
 */
import {
	collection,
	defineRelations,
	defineSchema,
	t,
	type SchemaFromCollections,
} from "@tanishqkancharla/tandem-core"
import { DatabaseSync } from "node:sqlite"
import pg from "pg"
import type {
	TandemSqlDialect,
	TandemSqlRow,
	TandemSqlStatement,
} from "../src/sql.js"

export const schema = defineSchema({
	users: collection({ id: t.id(), name: t.string() }),
	threads: collection({
		id: t.id(),
		title: t.string(),
		archived: t.boolean(),
		updatedAt: t.number(),
	}),
	messages: collection({
		id: t.id(),
		threadId: t.string(),
		authorId: t.string(),
		body: t.string(),
		createdAt: t.number(),
		pinned: t.boolean(),
	}),
})
export type Schema = SchemaFromCollections<typeof schema.collections>
export type Message = Schema["messages"]

export const relations = defineRelations(schema, ({ one, many }) => ({
	threads: { messages: many("messages", { from: "id", to: "threadId" }) },
	messages: { author: one("users", { from: "authorId", to: "id" }) },
}))

export type Dialect = Exclude<TandemSqlDialect, "mysql">

export function tableDdl(dialect: Dialect) {
	const [real, boolean] =
		dialect === "postgres"
			? ["double precision", "boolean"]
			: ["real", "integer"]
	return [
		`create table "users" ("id" text primary key, "name" text not null)`,
		`create table "threads" ("id" text primary key, "title" text not null, "archived" ${boolean} not null, "updatedAt" ${real} not null)`,
		`create table "messages" ("id" text primary key, "threadId" text not null, "authorId" text not null, "body" text not null, "createdAt" ${real} not null, "pinned" ${boolean} not null)`,
	]
}

/** Secondary indexes, cumulative: config `n` has the first n. */
export const secondaryIndexes = [
	{
		name: "messages_thread_created",
		sql: `create index "messages_thread_created" on "messages" ("threadId", "createdAt")`,
	},
	{
		name: "messages_created",
		sql: `create index "messages_created" on "messages" ("createdAt")`,
	},
] as const

/** mulberry32, so every run seeds the same rows. */
export function random(seed: number) {
	return () => {
		seed = (seed + 0x6d2b79f5) | 0
		let value = Math.imul(seed ^ (seed >>> 15), 1 | seed)
		value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value
		return ((value ^ (value >>> 14)) >>> 0) / 4294967296
	}
}

export const start = 1_700_000_000_000

/**
 * About 100 messages per thread and 50 users. createdAt advances by whole
 * seconds with random gaps, so some messages tie.
 */
export function seedData(rows: number, seed = 1) {
	const next = random(seed)
	const threadCount = Math.max(1, Math.round(rows / 100))
	const users = Array.from({ length: 50 }, (_, index) => ({
		id: `user-${String(index).padStart(3, "0")}`,
		name: `User ${index}`,
	}))
	const threads = Array.from({ length: threadCount }, (_, index) => ({
		id: `thread-${String(index).padStart(5, "0")}`,
		title: `Thread ${index}`,
		archived: next() < 0.2,
		updatedAt: start + Math.floor(next() * rows) * 1000,
	}))
	let createdAt = start
	const messages: Message[] = Array.from({ length: rows }, (_, index) => {
		createdAt += Math.floor(next() * 3) * 1000
		return {
			id: `message-${String(index).padStart(7, "0")}`,
			threadId: threads[Math.floor(next() * threadCount)]!.id,
			authorId: users[Math.floor(next() * users.length)]!.id,
			body: `Message ${index} ${"lorem ipsum ".repeat(1 + Math.floor(next() * 8))}`,
			createdAt,
			pinned: next() < 0.05,
		}
	})
	return { users, threads, messages }
}

/** A database handle with the callbacks TandemServerSqlStorage takes. */
export type BenchDatabase = {
	dialect: Dialect
	query: (statement: TandemSqlStatement) => Promise<TandemSqlRow[]>
	commit: (statements: readonly TandemSqlStatement[]) => Promise<void>
	exec: (sql: string) => Promise<void>
	/** Plan text for a statement, as the database reports it. */
	explain: (statement: TandemSqlStatement) => Promise<unknown>
	/** Bytes each named index uses. */
	indexBytes: (name: string) => Promise<number>
	version: () => Promise<string>
	close: () => Promise<void>
}

export function openSqlite(path: string): BenchDatabase {
	const db = new DatabaseSync(path)
	db.exec("pragma journal_mode = wal")
	const statements = new Map<string, ReturnType<DatabaseSync["prepare"]>>()
	const prepare = (sql: string) => {
		const cached = statements.get(sql)
		if (cached) return cached
		const prepared = db.prepare(sql)
		statements.set(sql, prepared)
		return prepared
	}
	const run = ({ sql, parameters }: TandemSqlStatement) =>
		prepare(sql).all(...(parameters as never[])) as TandemSqlRow[]
	return {
		dialect: "sqlite",
		query: (statement) => Promise.resolve(run(statement)),
		commit: (statements) => {
			db.exec("begin")
			for (const statement of statements) run(statement)
			db.exec("commit")
			return Promise.resolve()
		},
		exec: (sql) => {
			statements.clear()
			db.exec(sql)
			return Promise.resolve()
		},
		explain: ({ sql, parameters }) =>
			Promise.resolve(
				db
					.prepare(`explain query plan ${sql}`)
					.all(...(parameters as never[]))
					.map((row) => row.detail),
			),
		indexBytes: (name) =>
			Promise.resolve(
				Number(
					(
						db
							.prepare("select sum(pgsize) as bytes from dbstat where name = ?")
							.get(name) as { bytes: number | null }
					).bytes ?? 0,
				),
			),
		version: () =>
			Promise.resolve(
				String(
					(db.prepare("select sqlite_version() as v").get() as { v: string }).v,
				),
			),
		close: () => {
			db.close()
			return Promise.resolve()
		},
	}
}

/** Opens a pool on its own schema, so runs never share tables. */
export async function openPostgres(
	url: string,
	schemaName: string,
): Promise<BenchDatabase> {
	const pool = new pg.Pool({ connectionString: url, max: 1 })
	const client = await pool.connect()
	await client.query(`drop schema if exists ${schemaName} cascade`)
	await client.query(`create schema ${schemaName}`)
	await client.query(`set search_path to ${schemaName}`)
	return {
		dialect: "postgres",
		query: async ({ sql, parameters }) =>
			(await client.query(sql, [...parameters])).rows,
		commit: async (statements) => {
			await client.query("begin")
			for (const { sql, parameters } of statements)
				await client.query(sql, [...parameters])
			await client.query("commit")
		},
		exec: async (sql) => {
			await client.query(sql)
		},
		explain: async ({ sql, parameters }) =>
			(
				await client.query(
					`explain (analyze, buffers, costs off, timing off, summary off) ${sql}`,
					[...parameters],
				)
			).rows.map((row) => row["QUERY PLAN"]),
		indexBytes: async (name) =>
			Number(
				(
					await client.query(
						`select pg_relation_size(to_regclass($1)) as bytes`,
						[`${schemaName}."${name}"`],
					)
				).rows[0].bytes ?? 0,
			),
		version: async () =>
			(await client.query("show server_version")).rows[0].server_version,
		close: async () => {
			await client.query(`drop schema ${schemaName} cascade`)
			client.release()
			await pool.end()
		},
	}
}
