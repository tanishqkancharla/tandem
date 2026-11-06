import {
	collection,
	defineRelations,
	defineSchema,
	t,
	tag,
	TandemClient,
	type ClientId,
	type RelationalQuery,
	type ScanWindow,
	type SchemaFromCollections,
} from "@tanishqkancharla/tandem-core"
import { afterEach, beforeEach, describe, expect, test } from "vitest"
import { TandemServer } from "../src/index.js"
import { TandemServerSqlStorage } from "../src/sql.js"
import {
	openSqlDatabase,
	sqlDatabaseNames,
	type SqlDatabase,
} from "./sqlDatabases.fixture.js"

const schema = defineSchema({
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
		score: t.number(),
		pinned: t.boolean(),
	}),
})
type Schema = SchemaFromCollections<typeof schema.collections>
type Message = Schema["messages"]

const relations = defineRelations(schema, ({ one, many }) => ({
	threads: { messages: many("messages", { from: "id", to: "threadId" }) },
	messages: {
		author: one("users", { from: "authorId", to: "id" }),
		thread: one("threads", { from: "threadId", to: "id" }),
	},
}))
type Query = RelationalQuery<Schema, typeof relations>

const targets: Record<string, string> = {
	messages: "messages",
	author: "users",
	thread: "threads",
}
const operators = { gt: ">", gte: ">=", lt: "<", lte: "<=" } as const

/** Encodes a query as a client's scan window does. */
function encode(
	query: Omit<Query, "collection"> & { collection: string },
): unknown {
	const where = Object.entries(query.where ?? {}).flatMap(([field, value]) =>
		value === undefined
			? []
			: typeof value === "object" && value !== null
				? Object.entries(value).map(([operator, operand]) => [
						field,
						operators[operator as keyof typeof operators],
						operand,
					])
				: [[field, "=", value]],
	)
	return {
		collection: query.collection,
		where,
		order: Object.entries(query.orderBy ?? {}),
		limit: query.limit,
		offset: query.offset,
		...(query.with && {
			with: Object.fromEntries(
				Object.entries(query.with).map(([relation, nested]) => [
					relation,
					encode({
						...(nested === true ? {} : nested),
						collection: targets[relation]!,
					} as never),
				]),
			),
		}),
	}
}

function ddl(dialect: SqlDatabase["dialect"]) {
	const [real, boolean] =
		dialect === "postgres"
			? ["double precision", "boolean"]
			: ["real", "integer"]
	return [
		`create table "users" ("id" text primary key, "name" text not null)`,
		`create table "threads" ("id" text primary key, "title" text not null, "archived" ${boolean} not null, "updatedAt" ${real} not null)`,
		// An integer column checks that fractional parameters still compare.
		`create table "messages" ("id" text primary key, "threadId" text not null, "authorId" text not null, "body" text not null, "createdAt" ${real} not null, "score" integer not null, "pinned" ${boolean} not null)`,
		`create index "messages_thread_created" on "messages" ("threadId", "createdAt")`,
	]
}

/** mulberry32: a small seeded generator, so failures replay. */
function random(seed: number) {
	return () => {
		seed = (seed + 0x6d2b79f5) | 0
		let value = Math.imul(seed ^ (seed >>> 15), 1 | seed)
		value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value
		return ((value ^ (value >>> 14)) >>> 0) / 4294967296
	}
}

const strings = [
	"",
	"a",
	"A",
	"é",
	"é",
	"😀",
	"￿",
	"",
	"10",
	"9",
	"%",
	"_",
	"Robert'); drop table messages;--",
	"�",
]
const ids = ["m", "M", "é", "😀", "￿", "", "10", "9", "a b"]

function seedRecords(next: () => number, dialect: SqlDatabase["dialect"]) {
	const pick = <T>(values: readonly T[]) =>
		values[Math.floor(next() * values.length)]!
	// Postgres stores NaN; SQLite turns it into NULL and D1 turns Infinity
	// into NULL, which no schema number decodes.
	const numbers = [
		0,
		-0,
		1,
		2,
		2,
		3,
		3,
		3,
		1.5,
		-7,
		1_700_000_000_000,
		...(dialect === "postgres" ? [Number.NaN, Infinity, -Infinity] : []),
	]
	const users = ["u1", "u2", "u3"].map((id) => ({ id, name: pick(strings) }))
	const threads = ["t1", "t2", "t3", "t4"].map((id) => ({
		id,
		title: pick(strings),
		archived: next() < 0.3,
		updatedAt: pick(numbers),
	}))
	const messages: Message[] = Array.from({ length: 120 }, (_, index) => ({
		id: `${pick(ids)}-${index}`,
		threadId: pick(["t1", "t2", "t3", "t4", "orphan"]),
		authorId: pick(["u1", "u2", "u3", "missing"]),
		body: pick(strings),
		createdAt: pick(numbers),
		score: Math.floor(next() * 4),
		pinned: next() < 0.4,
	}))
	return { users, threads, messages }
}

function generateQuery(next: () => number): Query {
	const pick = <T>(values: readonly T[]) =>
		values[Math.floor(next() * values.length)]!
	const maybe = <T>(value: () => T) => (next() < 0.5 ? value() : undefined)
	const number = () =>
		pick([0, -0, 1, 2, 3, 1.5, 2.5, -7, Infinity, -Infinity, 1_700_000_000_000])
	const range = () =>
		pick([
			{ gte: number() },
			{ gt: number() },
			{ lt: number() },
			{ lte: number() },
			{ gt: number(), lte: number() },
		])
	const where = {
		threadId: maybe(() => pick(["t1", "t2", "orphan", "missing"])),
		authorId: maybe(() => pick(["u1", "u2"])),
		pinned: maybe(() =>
			pick([true, false, { gte: true }, { lt: false }] as const),
		),
		createdAt: maybe(() =>
			pick([number(), range(), range(), "3" as unknown as number]),
		),
		score: maybe(() =>
			pick([
				1,
				2,
				1.5,
				{ gte: 2 },
				{ gt: 0.5 },
				{ gte: "a" as unknown as number },
			]),
		),
		body: maybe(() =>
			pick([
				pick(strings),
				"\u0000",
				"a\u0000",
				"\ud800",
				{ gt: "a" },
				{ lte: "😀" },
			]),
		),
	}
	const orderBy = pick([
		undefined,
		{ createdAt: "desc" },
		{ createdAt: "asc" },
		{ createdAt: "desc", score: "asc" },
		{ score: "desc", createdAt: "desc" },
		{ score: "asc", body: "desc" },
		{ body: "asc" },
		{ createdAt: "desc", id: "desc" },
		{ id: "asc" },
	] as const)
	const page = {
		limit: maybe(() => pick([0, 1, 3, 10])),
		offset: maybe(() => pick([0, 2, 5])),
	}
	if (next() < 0.25)
		return {
			collection: "threads",
			where: maybe(() => ({ archived: next() < 0.5 })),
			orderBy: maybe(() => ({ updatedAt: pick(["asc", "desc"] as const) })),
			limit: page.limit,
			with: {
				messages: {
					where: { createdAt: maybe(range), pinned: maybe(() => next() < 0.5) },
					orderBy: maybe(() => ({ createdAt: "desc" as const })),
					limit: maybe(() => pick([1, 2, 5])),
					offset: maybe(() => pick([0, 1])),
					with: { author: true },
				},
			},
		} as Query
	return {
		collection: "messages",
		where,
		orderBy,
		...page,
		...(next() < 0.3 ? { with: { author: true, thread: true } } : {}),
	} as Query
}

for (const name of sqlDatabaseNames) {
	describe(`${name} query pushdown`, { timeout: 60_000 }, () => {
		let db: SqlDatabase
		let sql: TandemServerSqlStorage<Schema>
		let rowsRead = 0
		let server: TandemServer<Schema, typeof relations>
		/** The same tables, read the way every query read them before pushdown. */
		let fullReads: TandemServer<Schema, typeof relations>

		beforeEach(async () => {
			db = await openSqlDatabase(name)
			for (const statement of ddl(db.dialect)) await db.exec(statement)
			sql = new TandemServerSqlStorage({
				schema,
				dialect: db.dialect,
				query: async (statement) => {
					const rows = await db.query(statement)
					rowsRead += rows.length
					return rows
				},
				commit: db.commit,
			})
			server = new TandemServer({ schema, relations, storage: sql })
			fullReads = new TandemServer({
				schema,
				relations,
				storage: {
					scan: (args) => sql.scan(args),
					commit: (writes) => sql.commit(writes),
					close: async () => {},
				},
			})
		}, 30_000)
		afterEach(async () => {
			await server.close()
			await fullReads.close()
			await db.close()
		})

		async function seed(seedValue: number) {
			const records = seedRecords(random(seedValue), db.dialect)
			const tx = server.transact()
			for (const user of records.users) tx.set("users", user)
			for (const thread of records.threads) tx.set("threads", thread)
			for (const message of records.messages) tx.set("messages", message)
			await server.commit(tx)
			return records
		}

		test("generated queries and pulls return what full reads return", async () => {
			await seed(1)
			const next = random(2)
			let nativeRows = 0
			let fullRows = 0
			for (let index = 0; index < 250; index++) {
				const query = generateQuery(next)
				rowsRead = 0
				const native = await server.query(query)
				nativeRows += rowsRead
				rowsRead = 0
				const full = await fullReads.query(query)
				fullRows += rowsRead
				expect(native, JSON.stringify(query)).toEqual(full)

				const scanWindow = [encode(query)] as ScanWindow<Schema>
				const pull = { clientId: tag<ClientId>("reader"), scanWindow }
				const [nativePull, fullPull] = [
					await server.pull(pull),
					await fullReads.pull(pull),
				]
				expect(
					"patch" in nativePull && nativePull.patch.set,
					JSON.stringify(scanWindow),
				).toEqual("patch" in fullPull && fullPull.patch.set)
			}
			// Equality filters and limits read far fewer rows than whole tables.
			expect(nativeRows).toBeLessThan(fullRows / 2)
		}, 120_000)

		test("paged subscriptions follow records into and out of the page", async () => {
			await seed(3)
			const query = {
				collection: "messages",
				where: { threadId: "t1" },
				orderBy: { createdAt: "desc" },
				limit: 3,
				offset: 1,
				with: { author: true },
			} as const satisfies Query
			const results: unknown[] = []
			const subscription = await server.subscribe(query, (result) =>
				results.push(result),
			)
			expect(subscription.result).toEqual(await fullReads.query(query))
			const changes: ((tx: ReturnType<typeof server.transact>) => unknown)[] = [
				// Newer than every page row: shifts the page.
				(tx) =>
					tx.set("messages", {
						id: "new",
						threadId: "t1",
						authorId: "u1",
						body: "new",
						createdAt: 1e15,
						score: 1,
						pinned: false,
					}),
				// Tied with it on createdAt with a smaller ID: key order breaks the tie.
				(tx) =>
					tx.set("messages", {
						id: "a-new",
						threadId: "t1",
						authorId: "u2",
						body: "tied",
						createdAt: 1e15,
						score: 1,
						pinned: false,
					}),
				// Moves out of the thread.
				(tx) => tx.update("messages", "new", { threadId: "t2" }),
				// An include's target changes.
				(tx) => tx.update("users", "u2", { name: "renamed" }),
				(tx) => tx.remove("messages", "a-new"),
			]
			for (const change of changes) {
				const tx = server.transact()
				await change(tx)
				await server.commit(tx)
				await expect
					.poll(() => results.at(-1))
					.toEqual(await fullReads.query(query))
			}
			subscription.destroy()
		})

		test("queries inside a transaction see its staged writes", async () => {
			await seed(4)
			const message = (id: string, createdAt: number) => ({
				id,
				threadId: "fresh",
				authorId: "u1",
				body: id,
				createdAt,
				score: 0,
				pinned: true,
			})
			const committed = server.transact()
			committed.set("messages", message("committed", 1))
			await server.commit(committed)
			const query = {
				collection: "messages",
				where: { threadId: "fresh" },
				orderBy: { createdAt: "desc" },
				limit: 1,
			} as const satisfies Query
			const tx = server.transact()
			tx.set("messages", message("staged", 2))
			expect(await tx.query(query)).toEqual([message("staged", 2)])
			tx.remove("messages", "committed")
			tx.remove("messages", "staged")
			expect(await tx.query(query)).toEqual([])
			await tx.cancel()
		})

		test("hostile scan windows reach SQL only as parameters", async () => {
			await seed(6)
			const hostile = "1; drop table messages; --"
			for (const scanWindow of [
				[
					{
						collection: "messages",
						where: [["score", hostile, 0]],
						order: [["createdAt", "desc"]],
						limit: 2,
					},
				],
				[
					{
						collection: "messages",
						where: [["threadId", "=", hostile]],
						order: [["createdAt", hostile]],
						limit: 2,
					},
				],
				[
					{
						collection: "messages",
						where: [["threadId", "=", "t1"]],
						order: [["createdAt", "constructor"]],
						limit: 2,
					},
				],
				// Inherited names are not fields; unknown collections hold nothing.
				[{ collection: "messages", where: [["constructor", "=", "x"]] }],
				[{ collection: "messages", order: [["toString", "asc"]], limit: 2 }],
				[{ collection: "nope", where: [["id", ">", 1]] }],
				// Pages that are not counts still page as the query engine does.
				...[-1, 1.5, "2", 1e20, Number.NaN].flatMap((page) => [
					[
						{
							collection: "messages",
							where: [["threadId", "=", "t1"]],
							order: [["createdAt", "desc"]],
							limit: page,
						},
					],
					[
						{
							collection: "messages",
							where: [["threadId", "=", "missing"]],
							order: [["createdAt", "desc"]],
							limit: page,
						},
					],
					[
						{
							collection: "messages",
							order: [["createdAt", "desc"]],
							offset: page,
							limit: 2,
						},
					],
				]),
			] as unknown as ScanWindow<Schema>[]) {
				const pull = { clientId: tag<ClientId>("hostile"), scanWindow }
				const native = await server.pull(pull)
				const full = await fullReads.pull(pull)
				expect("patch" in native && native.patch.set).toEqual(
					"patch" in full && full.patch.set,
				)
			}
			expect(await server.query({ collection: "messages" })).toHaveLength(120)
		})

		test("pages that are not counts slice as arrays do", async () => {
			await seed(7)
			const pages: [offset: unknown, limit: unknown][] = [
				[-5, 10],
				[-5, 2],
				[3, -1],
				[1.5, 4],
				[2, 2.5],
				[Number.NaN, 3],
				[2, Number.NaN],
				[1e20, 3],
				// Each a count, but their sum is not a safe integer.
				[Number.MAX_SAFE_INTEGER, 1],
			]
			for (const [offset, limit] of pages)
				for (const threadId of ["t1", "missing"]) {
					const query = {
						collection: "messages",
						where: { threadId },
						orderBy: { createdAt: "desc" },
						offset,
						limit,
					} as unknown as Query
					expect(
						await server.query(query),
						JSON.stringify({ offset, limit, threadId }),
					).toEqual(await fullReads.query(query))
				}
		})

		test("nullable columns stay tied with every number", async () => {
			type Task = { id: string; title: string; dueAt?: number | null }
			type TaskSchema = { tasks: Task }
			const taskSchema = defineSchema({
				tasks: collection<Task>({ fields: ["id", "title", "dueAt"] }),
			})
			await db.exec(
				`create table "tasks" ("id" text primary key, "title" text not null, "due_at" ${db.dialect === "postgres" ? "double precision" : "real"})`,
			)
			const storage = (pushdown: boolean) => {
				const tasks = new TandemServerSqlStorage<TaskSchema>({
					dialect: db.dialect,
					schema: taskSchema,
					tables: {
						tasks: {
							table: "tasks",
							idColumns: ["id"],
							encode: ({ title, dueAt }) => ({ title, due_at: dueAt ?? null }),
							// NULL reads back as a missing field, as an optional field would.
							decode: ({ id, title, due_at }) => ({
								id: id as string,
								title: title as string,
								...(due_at === null ? {} : { dueAt: due_at as number }),
							}),
							fields: {
								title: { column: "title", type: "string" },
								dueAt: { column: "due_at", type: "number", nullable: true },
							},
						},
					},
					query: db.query,
					commit: db.commit,
				})
				return pushdown
					? tasks
					: {
							scan: tasks.scan.bind(tasks),
							commit: tasks.commit.bind(tasks),
							close: () => Promise.resolve(),
						}
			}
			const native = new TandemServer({
				schema: taskSchema,
				relations: {},
				storage: storage(true),
			})
			const full = new TandemServer({
				schema: taskSchema,
				relations: {},
				storage: storage(false),
			})
			const tx = native.transact()
			for (const [id, dueAt] of [
				["a", 1],
				["b", undefined],
				["c", 3],
				["d", 2],
				["e", undefined],
			] as const)
				tx.set("tasks", {
					id,
					title: id,
					...(dueAt === undefined ? {} : { dueAt }),
				})
			await native.commit(tx)
			for (const query of [
				{ collection: "tasks", where: { dueAt: { gte: 2 } } },
				{ collection: "tasks", where: { dueAt: { lte: 2 } } },
				{ collection: "tasks", where: { dueAt: { gt: 1 } } },
				{ collection: "tasks", where: { dueAt: { lt: 3 } } },
				{ collection: "tasks", orderBy: { dueAt: "desc" }, limit: 2 },
				{ collection: "tasks", orderBy: { dueAt: "asc" }, limit: 3 },
			] as const) {
				expect(
					await native.query(query as never),
					JSON.stringify(query),
				).toEqual(await full.query(query as never))
			}
			await native.close()
			await full.close()
		})

		test("string query values SQL cannot compare exactly still match", async () => {
			// Drivers store lone surrogates as U+FFFD; queries still compare the
			// decoded record with the exact query value.
			const tx = server.transact()
			tx.set("users", { id: "lone", name: "\ud800" })
			tx.set("users", { id: "replacement", name: "�" })
			// Postgres rejects NUL in text; node:sqlite reads text only up to NUL.
			if (name === "d1") tx.set("users", { id: "nul", name: "a\u0000b" })
			await server.commit(tx)
			for (const value of ["\ud800", "�", "a\u0000b", "a", "\u0000"]) {
				const query = { collection: "users", where: { name: value } } as const
				expect(await server.query(query), value).toEqual(
					await fullReads.query(query),
				)
			}
		})

		test.skipIf(name === "sqlite" || name === "d1")(
			"NaN stays tied with every number in ranges and order",
			async () => {
				const tx = server.transact()
				for (const [id, createdAt] of [
					["a", 1],
					["b", Number.NaN],
					["c", 3],
					["d", 2],
				] as const)
					tx.set("messages", {
						id,
						threadId: "t",
						authorId: "u",
						body: "",
						createdAt,
						score: 0,
						pinned: false,
					})
				await server.commit(tx)
				for (const query of [
					{ collection: "messages", where: { createdAt: { lte: 2 } } },
					{ collection: "messages", where: { createdAt: { gt: 1 } } },
					{ collection: "messages", orderBy: { createdAt: "desc" }, limit: 2 },
					{ collection: "messages", orderBy: { createdAt: "asc" }, limit: 1 },
				] as const satisfies Query[]) {
					expect(await server.query(query), JSON.stringify(query)).toEqual(
						await fullReads.query(query),
					)
				}
			},
		)

		test("a paged client subscription syncs another client's writes", async () => {
			await seed(5)
			const author = new TandemClient({ schema, relations, remote: server })
			const viewer = new TandemClient({ schema, relations, remote: server })
			const query = {
				collection: "messages",
				where: { threadId: "t2" },
				orderBy: { createdAt: "desc" },
				limit: 4,
			} as const satisfies Query
			const results: unknown[] = []
			const subscription = viewer.subscribe(query, (result) =>
				results.push(result),
			)
			await viewer.pullFromRemote()
			expect(viewer.query(query)).toEqual(await fullReads.query(query))
			const tx = author.transact()
			tx.set("messages", {
				id: "from-author",
				threadId: "t2",
				authorId: "u1",
				body: "hello",
				createdAt: 1e15,
				score: 0,
				pinned: false,
			})
			await author.commit(tx)
			await expect
				.poll(async () => {
					await viewer.pullFromRemote()
					return viewer.query(query)
				})
				.toEqual(await fullReads.query(query))
			expect(viewer.query(query)[0]?.id).toBe("from-author")
			subscription.destroy()
			await author.close()
			await viewer.close()
		})
	})
}
