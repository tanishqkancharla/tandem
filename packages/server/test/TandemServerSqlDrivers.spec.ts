import {
	collection,
	defineSchema,
	t,
	tag,
	TandemClient,
	type ClientId,
	type MutationId,
	type SchemaFromCollections,
} from "@tanishqkancharla/tandem-core"
import * as errore from "errore"
import { Miniflare } from "miniflare"
import mysql from "mysql2"
import pg from "pg"
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest"
import { TandemServer, type TandemServerStorageApi } from "../src/index.js"
import {
	TandemServerD1Storage,
	TandemServerMysqlStorage,
	TandemServerPostgresStorage,
	type TandemSqlRow,
} from "../src/sql.js"

const schema = defineSchema({
	tasks: collection({
		id: t.id(),
		text: t.string(),
		done: t.boolean(),
		score: t.number(),
	}),
})
type Schema = SchemaFromCollections<typeof schema.collections>
type Database = {
	storage: () => TandemServerStorageApi<Schema>
	query: (sql: string) => Promise<TandemSqlRow[]>
	close: () => Promise<void>
}

async function database(
	dialect: "d1" | "postgres" | "mysql",
): Promise<Database> {
	if (dialect === "d1") {
		const runtime = new Miniflare({
			modules: true,
			script: "export default {fetch() {return new Response('ok')}}",
			compatibilityDate: "2026-07-01",
			d1Databases: { DB: "schema-storage-test" },
		})
		const db = await runtime.getD1Database("DB")
		return {
			storage: () => new TandemServerD1Storage({ schema, database: db }),
			query: async (sql) => (await db.prepare(sql).all()).results,
			close: () => runtime.dispose(),
		}
	}
	if (dialect === "postgres") {
		const db = new pg.Pool({
			connectionString: process.env.TANDEM_POSTGRES_URL,
		})
		return {
			storage: () => new TandemServerPostgresStorage({ schema, database: db }),
			query: async (sql) => (await db.query(sql)).rows,
			close: () => db.end(),
		}
	}
	const db = mysql.createPool(process.env.TANDEM_MYSQL_URL!)
	return {
		storage: () => new TandemServerMysqlStorage({ schema, database: db }),
		query: async (sql) => (await db.promise().query(sql))[0] as TandemSqlRow[],
		close: () => db.promise().end(),
	}
}

for (const dialect of ["d1", "postgres", "mysql"] as const) {
	describe.skipIf(
		(dialect === "postgres" && !process.env.TANDEM_POSTGRES_URL) ||
			(dialect === "mysql" && !process.env.TANDEM_MYSQL_URL),
	)(`${dialect} schema and database handle`, () => {
		let db: Database
		let server: TandemServer<Schema, {}>
		beforeAll(async () => {
			db = await database(dialect)
		}, 30_000)
		afterAll(async () => {
			await db?.close()
		})
		beforeEach(async () => {
			await db.query("drop table if exists tasks")
			await db.query(
				`create table tasks (id varchar(255) primary key, text varchar(255) not null, done ${dialect === "postgres" ? "boolean" : "integer"} not null, score double precision not null, audit_note varchar(255) default 'App owned', check (text <> 'forbidden'))`,
			)
			server = new TandemServer({
				schema,
				relations: {},
				storage: db.storage(),
			})
		})

		test("syncs existing rows with inferred names and types, preserving app columns", async () => {
			await using cleanup = new errore.AsyncDisposableStack()
			cleanup.defer(() => server.close())
			await db.query(
				"alter table tasks add column owner_id varchar(255) not null",
			)
			await db.query(
				`insert into tasks (id, text, done, score, owner_id) values ('existing', 'From SQL', ${dialect === "postgres" ? "false" : "0"}, 1.5, 'owner-1')`,
			)
			const alice = new TandemClient({ schema, remote: server })
			const bob = new TandemClient({ schema, remote: server })
			cleanup.defer(() => alice.close())
			cleanup.defer(() => bob.close())
			const subscription = bob.subscribe({ collection: "tasks" }, () => {})
			cleanup.defer(() => subscription.destroy())
			await bob.pullFromRemote()
			expect(bob.query({ collection: "tasks" })).toEqual([
				{ id: "existing", text: "From SQL", done: false, score: 1.5 },
			])
			const text = "Robert'); DROP TABLE tasks;--"
			const tx = alice.transact()
			tx.set("tasks", { id: "existing", text, done: true, score: 2.25 })
			await alice.commit(tx)
			await bob.pullFromRemote()
			expect(bob.query({ collection: "tasks" })).toEqual([
				{ id: "existing", text, done: true, score: 2.25 },
			])
			expect(await db.query("select * from tasks")).toEqual([
				{
					id: "existing",
					text,
					done: dialect === "postgres" ? true : 1,
					score: 2.25,
					audit_note: "App owned",
					owner_id: "owner-1",
				},
			])
			await alice.close()
			await bob.close()
			await server.close()
			const reopened = new TandemServer({
				schema,
				relations: {},
				storage: db.storage(),
			})
			cleanup.defer(() => reopened.close())
			expect(await reopened.query({ collection: "tasks" })).toEqual([
				{ id: "existing", text, done: true, score: 2.25 },
			])
			const remove = reopened.transact()
			remove.remove("tasks", "existing")
			await reopened.commit(remove)
			expect(await db.query("select * from tasks")).toEqual([])
		})

		test("rolls back failed writes and retries the same mutation atomically", async () => {
			await using cleanup = new errore.AsyncDisposableStack()
			cleanup.defer(() => server.close())
			const request = {
				clientId: tag<ClientId>("retry"),
				mutations: [
					{
						id: tag<MutationId>(1),
						ops: ["Valid", "forbidden"].map((text, index) => ({
							type: "set" as const,
							collection: "tasks" as const,
							value: { id: `task-${index}`, text, done: false, score: index },
						})),
					},
				],
			}
			expect(await server.push(request)).toMatchObject({ error: "unavailable" })
			expect(await db.query("select * from tasks")).toEqual([])
			request.mutations[0].ops[1].value.text = "Allowed"
			expect(await server.push(request)).toEqual({ ok: true })
			expect(await server.query({ collection: "tasks" })).toEqual([
				{ id: "task-0", text: "Valid", done: false, score: 0 },
				{ id: "task-1", text: "Allowed", done: false, score: 1 },
			])
		})
	})
}

test("rejects schemas without runtime field types before accessing the database", () => {
	const schema = defineSchema({
		tasks: collection<{ id: string; text: string }>({ fields: ["id", "text"] }),
	})
	// Invalid schema fails before any D1 binding can be used.
	expect(
		() => new TandemServerD1Storage({ schema, database: undefined! }),
	).toThrow("use collection({ id: t.id(), ... })")
})
