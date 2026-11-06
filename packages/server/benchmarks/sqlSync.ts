/**
 * Client sync through TandemServer on SQL storage: initial sync and
 * author-to-viewer update latency for several clients, comparing whole-table
 * reads with SQL reads. Writes one JSON file per run.
 *
 * pnpm --filter tandem-dst exec tsx ../packages/server/benchmarks/sqlSync.ts \
 *   <sqlite|postgres> <rows> <clients> <out.json> [rounds=3] [updates=10]
 *
 * Clients are TandemClient instances in this Node process with in-memory
 * replicas and the default 150 ms sync interval, connected to the server
 * directly rather than over HTTP. The tables carry the messages_thread_created
 * index. Each round runs four cells in a shuffled order: whole-table or SQL
 * reads, with every client on one paged thread view or on every message.
 */
import { execSync } from "node:child_process"
import { mkdirSync, rmSync, writeFileSync } from "node:fs"
import { cpus, freemem, loadavg, totalmem } from "node:os"
import { dirname, join } from "node:path"
import { performance } from "node:perf_hooks"
import { isDeepStrictEqual } from "node:util"
import {
	Logger,
	TandemClient,
	type RelationalQuery,
} from "@tanishqkancharla/tandem-core"
import { TandemServer } from "../src/TandemServer.js"
import { TandemServerSqlStorage } from "../src/storage/TandemServerSqlStorage.js"
import type { TandemServerStorageApi } from "../src/storage/TandemServerStorage.js"
import type { TandemSqlStatement } from "../src/sql.js"
import {
	openPostgres,
	openSqlite,
	random,
	relations,
	schema,
	secondaryIndexes,
	seedData,
	start,
	tableDdl,
	type Dialect,
	type Schema,
} from "./sqlWorkload.js"

const dialect = process.argv[2] as Dialect
const rows = Number(process.argv[3])
const clientCount = Number(process.argv[4])
const out = process.argv[5]!
const rounds = Number(process.argv[6] ?? 3)
const updates = Number(process.argv[7] ?? 10)

type Query = RelationalQuery<Schema, typeof relations>

const db =
	dialect === "sqlite"
		? (() => {
				const path = join(dirname(out), `sync-sqlite-${rows}-${clientCount}.db`)
				for (const suffix of ["", "-wal", "-shm"])
					rmSync(path + suffix, { force: true })
				return openSqlite(path)
			})()
		: await openPostgres(
				process.env.TANDEM_POSTGRES_URL!,
				`sync_${rows}_${clientCount}`,
			)

let statements = 0
let rowsDecoded = 0
const sql = new TandemServerSqlStorage<Schema>({
	schema,
	dialect,
	query: async (statement: TandemSqlStatement) => {
		statements++
		const result = await db.query(statement)
		rowsDecoded += result.length
		return result
	},
	commit: db.commit,
})
const storages: Record<"fullReads" | "sql", TandemServerStorageApi<Schema>> = {
	sql,
	fullReads: {
		scan: (args) => sql.scan(args),
		commit: (writes) => sql.commit(writes),
		close: () => Promise.resolve(),
	},
}

for (const statement of tableDdl(dialect)) await db.exec(statement)
await db.exec(secondaryIndexes[0].sql)
const data = seedData(rows)
const seeding = new TandemServer({ schema, relations, storage: sql })
const seedStarted = performance.now()
for (const [collection, records] of [
	["users", data.users],
	["threads", data.threads],
	["messages", data.messages],
] as const)
	for (let index = 0; index < records.length; index += 5000) {
		const tx = seeding.transact()
		for (const record of records.slice(index, index + 5000))
			tx.set(collection, record as never)
		await seeding.commit(tx)
	}
await seeding.close()
if (dialect === "postgres") await db.exec("analyze")
const seedMs = performance.now() - seedStarted

const busiest = [
	...Map.groupBy(data.messages, ({ threadId }) => threadId),
].sort((left, right) => right[1].length - left[1].length)[0]![0]
const views: Record<"paged" | "full", Query> = {
	paged: {
		collection: "messages",
		where: { threadId: busiest },
		orderBy: { createdAt: "desc" },
		limit: 20,
		with: { author: true },
	},
	full: { collection: "messages" },
}

const machine = () => ({
	at: new Date().toISOString(),
	loadavg: loadavg(),
	freeMemoryBytes: freemem(),
	totalMemoryBytes: totalmem(),
	cpus: cpus().length,
	cpuModel: cpus()[0]?.model,
})
const cells: unknown[] = []
const result = {
	dialect,
	rows,
	clients: clientCount,
	rounds,
	updates,
	node: process.version,
	database: await db.version(),
	commit: execSync("git rev-parse HEAD").toString().trim(),
	dirty: execSync("git status --porcelain -- packages").toString() !== "",
	seedMs,
	machineBefore: machine(),
	machineAfter: undefined as unknown,
	cells,
}
const checkpoint = () => {
	mkdirSync(dirname(out), { recursive: true })
	writeFileSync(out, JSON.stringify(result, null, "\t"))
}

const next = random(rows + clientCount)
const shuffle = <T>(values: readonly T[]) => {
	const shuffled = [...values]
	for (let index = shuffled.length - 1; index > 0; index--) {
		const other = Math.floor(next() * (index + 1))
		;[shuffled[index], shuffled[other]] = [shuffled[other]!, shuffled[index]!]
	}
	return shuffled
}

const logger = new Logger({ sinks: [] })
let written = 0

for (let round = 0; round < rounds; round++)
	for (const [reads, view] of shuffle([
		["fullReads", "paged"],
		["sql", "paged"],
		["fullReads", "full"],
		["sql", "full"],
	] as const)) {
		const server = new TandemServer({
			schema,
			relations,
			storage: storages[reads],
		})
		const query = views[view]
		statements = 0
		rowsDecoded = 0
		const clients = Array.from(
			{ length: clientCount },
			() => new TandemClient({ schema, relations, remote: server, logger }),
		)
		const latest = clients.map(() => undefined as unknown)
		const waiters = new Set<() => void>()
		const subscriptions = clients.map((client, index) =>
			client.subscribe(query, (value) => {
				latest[index] = value
				for (const waiter of waiters) waiter()
			}),
		)
		const until = (done: () => boolean) =>
			new Promise<void>((resolve) => {
				const check = () => {
					if (!done()) return
					waiters.delete(check)
					resolve()
				}
				waiters.add(check)
				check()
			})

		const initialStarted = performance.now()
		await Promise.all(clients.map((client) => client.pullFromRemote()))
		const initialMs = performance.now() - initialStarted
		const initialWork = { statements, rowsDecoded }
		const expectedInitial = await server.query(query)
		const initialExact = clients.every((client) =>
			isDeepStrictEqual(client.query(query), expectedInitial),
		)

		statements = 0
		rowsDecoded = 0
		const [author] = clients
		const updateMs: number[] = []
		const ids: string[] = []
		for (let update = 0; update < updates; update++) {
			const id = `sync-${written++}`
			ids.push(id)
			const tx = author!.transact()
			tx.set("messages", {
				id,
				threadId: busiest,
				authorId: "user-000",
				body: "hello",
				createdAt: start + rows * 3000 + written,
				pinned: false,
			})
			const started = performance.now()
			await author!.commit(tx)
			await until(() =>
				latest.every(
					(value, index) =>
						index === 0 ||
						(value as { id: string }[] | undefined)?.some(
							(message) => message.id === id,
						),
				),
			)
			updateMs.push(performance.now() - started)
		}
		const updateWork = { statements, rowsDecoded }
		// Every write reached the server, and every replica matches it.
		await Promise.all(clients.map((client) => client.pullFromRemote()))
		const expectedFinal = await server.query(query)
		const stored = await server.query({
			collection: "messages",
			where: { threadId: busiest },
		})
		cells.push({
			round,
			reads,
			view,
			initialMs,
			initialWork,
			initialExact,
			initialReplicaRows: clients.map((client) => client.query(query).length),
			updateMs,
			updateWork,
			finalExact: clients.every((client) =>
				isDeepStrictEqual(client.query(query), expectedFinal),
			),
			writesStored: ids.every((id) =>
				stored.some((message) => message.id === id),
			),
		})
		for (const subscription of subscriptions) subscription.destroy()
		await Promise.all(clients.map((client) => client.close()))
		await server.close()
		checkpoint()
	}

result.machineAfter = machine()
checkpoint()
await db.close()
console.log(
	`${dialect} ${rows} rows ${clientCount} clients: ${cells.length} cells`,
)
