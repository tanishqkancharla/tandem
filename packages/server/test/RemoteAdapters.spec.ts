import Database from "better-sqlite3"
import { TandemClient } from "../../core/src/TandemClient"
import { collection, defineSchema } from "../../core/src/schema/Schema"
import type { LoggerApi } from "../../core/src/utils/Logger"
import type { RemoteApi } from "@tandem/types"
import { describe, expect, test, vi } from "vitest"
import { drizzle as drizzleBetterSqlite } from "drizzle-orm/better-sqlite3"
import {
	sqliteTable,
	text as sqliteText,
	integer as sqliteInteger,
} from "drizzle-orm/sqlite-core"
import postgres from "postgres"
import { drizzle as drizzlePostgres } from "drizzle-orm/postgres-js"
import {
	pgTable,
	text as pgText,
	integer as pgInteger,
} from "drizzle-orm/pg-core"
import mysql from "mysql2/promise"
import { drizzle as drizzleMysql } from "drizzle-orm/mysql2"
import { mysqlTable, varchar, int as mysqlInt } from "drizzle-orm/mysql-core"
import { InMemoryRemote } from "../src/InMemoryRemote"
import { SQLiteDrizzleRemote } from "../src/drizzle/sqlite"
import { PgDrizzleRemote } from "../src/drizzle/pg"
import { MySqlDrizzleRemote } from "../src/drizzle/mysql"

type TestsThread = {
	id: string
	title: string
	status: "open" | "closed"
	createdAt: number
}

type TestsMessage = {
	id: string
	threadId: string
	body: string
	createdAt: number
}

type TestsSchema = {
	threads: TestsThread
	messages: TestsMessage
}

type RemoteProvider = {
	name: string
	kind: "memory" | "sqlite" | "docker"
	create: () => Promise<{
		remote: RemoteApi<TestsSchema>
		assertStored: (expected: TestsThread[]) => Promise<void>
		seed?: (records: TestsThread[]) => Promise<void>
		cleanup: () => Promise<void>
	}>
}

const testsRuntimeSchema = defineSchema({
	threads: collection<TestsThread>({
		fields: ["id", "title", "status", "createdAt"],
	}),
	messages: collection<TestsMessage>({
		fields: ["id", "threadId", "body", "createdAt"],
	}),
})

// The sync engine logs every push/pull; silence it so failed assertions stay readable.
const silentLogger: LoggerApi = {
	debug() {},
	log() {},
	info() {},
	warn() {},
	error() {},
	scope() {
		return silentLogger
	},
}

function thread(id: string, overrides: Partial<TestsThread> = {}): TestsThread {
	return {
		id,
		title: `Thread ${id}`,
		status: "open",
		createdAt: 1,
		...overrides,
	}
}

async function createClient(remote: RemoteApi<TestsSchema>, label: string) {
	const client = new TandemClient<TestsSchema>({
		autoConnect: false,
		logger: silentLogger,
		remote,
		rng: { randomId: () => label },
		schema: testsRuntimeSchema,
		syncInterval: 0,
	})
	await client.ready
	return client
}

function sortedThreads(records: TestsThread[]): TestsThread[] {
	return records.toSorted((left, right) => left.id.localeCompare(right.id))
}

function normalizeMysqlThreads(records: TestsThread[]): TestsThread[] {
	return records.map((record) => ({
		...record,
		// MySQL drivers can hydrate integer columns as strings depending on connection settings.
		createdAt: Number(record.createdAt),
	}))
}

async function readThreadsFromRemote(
	remote: RemoteApi<TestsSchema>,
	label: string,
): Promise<TestsThread[]> {
	const client = await createClient(remote, label)
	await client.connect()
	const subscription = client.subscribe({ collection: "threads" }, () => {})

	try {
		await client.pullFromRemote()
		return client.query({ collection: "threads" })
	} finally {
		subscription.destroy()
		await client.disconnect()
	}
}

async function seedThreadsThroughRemote(
	remote: RemoteApi<TestsSchema>,
	label: string,
	records: TestsThread[],
) {
	const client = await createClient(remote, label)

	try {
		await client.connect()
		const tx = client.transact()
		for (const record of records) {
			tx.set("threads", record)
		}
		await client.commit(tx)
	} finally {
		await client.disconnect()
	}
}

const sqliteThreads = sqliteTable("threads", {
	id: sqliteText("id").primaryKey(),
	title: sqliteText("title").notNull(),
	status: sqliteText("status").notNull(),
	createdAt: sqliteInteger("created_at").notNull(),
})

const sqliteMessages = sqliteTable("messages", {
	id: sqliteText("id").primaryKey(),
	threadId: sqliteText("thread_id").notNull(),
	body: sqliteText("body").notNull(),
	createdAt: sqliteInteger("created_at").notNull(),
})

const pgThreads = pgTable("threads", {
	id: pgText("id").primaryKey(),
	title: pgText("title").notNull(),
	status: pgText("status").notNull(),
	createdAt: pgInteger("created_at").notNull(),
})

const pgMessages = pgTable("messages", {
	id: pgText("id").primaryKey(),
	threadId: pgText("thread_id").notNull(),
	body: pgText("body").notNull(),
	createdAt: pgInteger("created_at").notNull(),
})

const mysqlThreads = mysqlTable("threads", {
	id: varchar("id", { length: 255 }).primaryKey(),
	title: varchar("title", { length: 255 }).notNull(),
	status: varchar("status", { length: 255 }).notNull(),
	createdAt: mysqlInt("created_at").notNull(),
})

const mysqlMessages = mysqlTable("messages", {
	id: varchar("id", { length: 255 }).primaryKey(),
	threadId: varchar("thread_id", { length: 255 }).notNull(),
	body: varchar("body", { length: 255 }).notNull(),
	createdAt: mysqlInt("created_at").notNull(),
})

const memoryProvider: RemoteProvider = {
	name: "memory",
	kind: "memory",
	async create() {
		const remote = new InMemoryRemote<TestsSchema>()
		return {
			remote,
			async assertStored(expected) {
				expect(
					sortedThreads(await readThreadsFromRemote(remote, "memory-assert")),
				).toEqual(sortedThreads(expected))
			},
			async seed(records) {
				await seedThreadsThroughRemote(remote, "memory-seed", records)
			},
			async cleanup() {
				await remote.destroy()
			},
		}
	},
}

const sqliteProvider: RemoteProvider = {
	name: "sqlite",
	kind: "sqlite",
	async create() {
		const sqlite = new Database(":memory:")
		sqlite.exec(`
			create table threads (
				id text primary key,
				title text not null,
				status text not null,
				created_at integer not null
			);

			create table messages (
				id text primary key,
				thread_id text not null,
				body text not null,
				created_at integer not null
			);
		`)
		const db = drizzleBetterSqlite(sqlite)

		return {
			remote: new SQLiteDrizzleRemote<TestsSchema>({
				db,
				tables: {
					threads: sqliteThreads as any,
					messages: sqliteMessages as any,
				},
			}),
			async assertStored(expected) {
				const rows = await db
					.select()
					.from(sqliteThreads)
					.orderBy(sqliteThreads.id)
				expect(rows).toEqual(sortedThreads(expected))
			},
			async seed(records) {
				await db.insert(sqliteThreads).values(records)
			},
			async cleanup() {
				sqlite.close()
			},
		}
	},
}

const postgresProvider: RemoteProvider = {
	name: "postgres",
	kind: "docker",
	async create() {
		const sql = postgres(
			"postgres://postgres:postgres@localhost:54329/tandem_test",
		)
		await sql`
			create table if not exists threads (
				id text primary key,
				title text not null,
				status text not null,
				created_at integer not null
			)
		`
		await sql`
			create table if not exists messages (
				id text primary key,
				thread_id text not null,
				body text not null,
				created_at integer not null
			)
		`
		await sql`truncate table messages, threads`
		const db = drizzlePostgres(sql)

		return {
			remote: new PgDrizzleRemote<TestsSchema>({
				db,
				tables: {
					threads: pgThreads as any,
					messages: pgMessages as any,
				},
			}),
			async assertStored(expected) {
				const rows = await db.select().from(pgThreads).orderBy(pgThreads.id)
				expect(rows).toEqual(sortedThreads(expected))
			},
			async seed(records) {
				await db.insert(pgThreads).values(records)
			},
			async cleanup() {
				await sql`truncate table messages, threads`
				await sql.end()
			},
		}
	},
}

const mysqlProvider: RemoteProvider = {
	name: "mysql",
	kind: "docker",
	async create() {
		const connection = await mysql.createConnection({
			host: "127.0.0.1",
			port: 33069,
			user: "root",
			password: "mysql",
			database: "tandem_test",
		})
		await connection.execute(`
			create table if not exists threads (
				id varchar(255) primary key,
				title varchar(255) not null,
				status varchar(255) not null,
				created_at int not null
			)
		`)
		await connection.execute(`
			create table if not exists messages (
				id varchar(255) primary key,
				thread_id varchar(255) not null,
				body varchar(255) not null,
				created_at int not null
			)
		`)
		await connection.execute("truncate table messages")
		await connection.execute("truncate table threads")
		const db = drizzleMysql(connection)

		return {
			remote: new MySqlDrizzleRemote<TestsSchema>({
				db,
				tables: {
					threads: mysqlThreads as any,
					messages: mysqlMessages as any,
				},
			}),
			async assertStored(expected) {
				const rows = await db
					.select()
					.from(mysqlThreads)
					.orderBy(mysqlThreads.id)
				expect(normalizeMysqlThreads(rows as TestsThread[])).toEqual(
					sortedThreads(expected),
				)
			},
			async seed(records) {
				await db.insert(mysqlThreads).values(records)
			},
			async cleanup() {
				await connection.execute("truncate table messages")
				await connection.execute("truncate table threads")
				await connection.end()
			},
		}
	},
}

function getRemoteProviders(): RemoteProvider[] {
	const requested = new Set(
		(process.env.TANDEM_REMOTE_PROVIDER ?? "")
			.split(",")
			.map((provider) => provider.trim())
			.filter(Boolean),
	)
	const dockerEnabled = process.env.TANDEM_DOCKER_TESTS === "1"
	const allProviders = [
		memoryProvider,
		sqliteProvider,
		postgresProvider,
		mysqlProvider,
	]
	const providers = [
		memoryProvider,
		sqliteProvider,
		...(dockerEnabled ? [postgresProvider, mysqlProvider] : []),
	]

	if (requested.size === 0) return providers

	const allProviderNames = new Set(allProviders.map((provider) => provider.name))
	const enabledProviderNames = new Set(providers.map((provider) => provider.name))
	const unknownProviders = Array.from(requested).filter(
		(provider) => !allProviderNames.has(provider),
	)
	const unavailableProviders = Array.from(requested).filter(
		(provider) =>
			allProviderNames.has(provider) && !enabledProviderNames.has(provider),
	)

	if (unknownProviders.length > 0 || unavailableProviders.length > 0) {
		const details = [
			unknownProviders.length > 0
				? `unknown provider(s): ${unknownProviders.join(", ")}`
				: undefined,
			unavailableProviders.length > 0
				? `docker provider(s) requested without TANDEM_DOCKER_TESTS=1: ${unavailableProviders.join(", ")}`
				: undefined,
		].filter(Boolean)

		throw new Error(
			`Invalid TANDEM_REMOTE_PROVIDER="${process.env.TANDEM_REMOTE_PROVIDER}". ${details.join("; ")}. Available providers: memory, sqlite${dockerEnabled ? ", postgres, mysql" : " (set TANDEM_DOCKER_TESTS=1 or run test:docker for postgres, mysql)"}.`,
		)
	}

	return providers.filter((provider) => requested.has(provider.name))
}

const remoteProviders = getRemoteProviders()

describe.each(remoteProviders)("$name remote", (provider) => {
	test("push set stores row", async () => {
		const context = await provider.create()
		const client = await createClient(context.remote, `${provider.name}-set`)

		try {
			await client.connect()
			const tx = client.transact()
			tx.set("threads", thread("thread-1", { title: "Write tests" }))
			await client.commit(tx)

			await context.assertStored([thread("thread-1", { title: "Write tests" })])
		} finally {
			await client.disconnect()
			await context.cleanup()
		}
	})

	test("push remove deletes row", async () => {
		const context = await provider.create()
		const client = await createClient(context.remote, `${provider.name}-remove`)

		try {
			await client.connect()
			const setTx = client.transact()
			setTx.set("threads", thread("thread-1"))
			await client.commit(setTx)

			const removeTx = client.transact()
			removeTx.remove("threads", "thread-1")
			await client.commit(removeTx)

			await context.assertStored([])
		} finally {
			await client.disconnect()
			await context.cleanup()
		}
	})

	test("pull reads seeded rows", async () => {
		const context = await provider.create()
		const client = await createClient(context.remote, `${provider.name}-pull`)
		const seeded = [
			thread("thread-1", { title: "Seeded remotely", createdAt: 4 }),
		]

		try {
			await context.seed?.(seeded)
			await client.connect()
			const subscription = client.subscribe({ collection: "threads" }, () => {})
			await client.pullFromRemote()

			expect(client.query({ collection: "threads" })).toEqual(seeded)
			subscription.destroy()
		} finally {
			await client.disconnect()
			await context.cleanup()
		}
	})

	test("query operators are respected", async () => {
		const context = await provider.create()
		const client = await createClient(context.remote, `${provider.name}-query`)
		const records = [
			thread("thread-1", { title: "Low open", createdAt: 1 }),
			thread("thread-2", {
				title: "Closed high",
				status: "closed",
				createdAt: 5,
			}),
			thread("thread-3", { title: "Middle open", createdAt: 3 }),
			thread("thread-4", { title: "High open", createdAt: 4 }),
			thread("thread-5", { title: "Too high open", createdAt: 6 }),
		]

		try {
			await context.seed?.(records)
			await client.connect()
			const query = {
				collection: "threads",
				where: { status: "open", createdAt: { lte: 4 } },
				orderBy: { createdAt: "desc" },
				limit: 2,
				offset: 1,
			} as const
			const subscription = client.subscribe(query, () => {})
			await client.pullFromRemote()

			expect(
				client.query({
					collection: "threads",
					orderBy: { createdAt: "desc" },
				}),
			).toEqual([
				thread("thread-3", { title: "Middle open", createdAt: 3 }),
				thread("thread-1", { title: "Low open", createdAt: 1 }),
			])
			subscription.destroy()
		} finally {
			await client.disconnect()
			await context.cleanup()
		}
	})

	test("poke updates subscribed client", async () => {
		const context = await provider.create()
		const client1 = await createClient(
			context.remote,
			`${provider.name}-pusher`,
		)
		const client2 = await createClient(
			context.remote,
			`${provider.name}-subscriber`,
		)

		try {
			await client2.connect()
			const subscription = client2.subscribe(
				{ collection: "threads" },
				() => {},
			)
			await client2.pullFromRemote()

			await client1.connect()
			const tx = client1.transact()
			tx.set("threads", thread("thread-1", { title: "Poked", createdAt: 3 }))
			await client1.commit(tx)

			await vi.waitFor(() => {
				expect(client2.query({ collection: "threads" })).toEqual([
					thread("thread-1", { title: "Poked", createdAt: 3 }),
				])
			})

			subscription.destroy()
		} finally {
			await client1.disconnect()
			await client2.disconnect()
			await context.cleanup()
		}
	})
})
