/**
 * Query latency through TandemServer.query on one database and table size,
 * comparing whole-table reads with SQL reads under 0, 1, and 2 secondary
 * indexes. Writes one JSON file per run.
 *
 * pnpm --filter tandem-dst exec tsx ../packages/server/benchmarks/sqlQueries.ts \
 *   <sqlite|postgres> <rows> <out.json> [samples=15] [rounds=3]
 *
 * SQLite runs Node's built-in node:sqlite on a WAL file in the output
 * directory. Postgres needs TANDEM_POSTGRES_URL. Each round runs every
 * configuration in a shuffled order: it drops and creates the secondary
 * indexes, warms up, then times every workload in a shuffled order.
 */
import { execSync } from "node:child_process"
import { mkdirSync, rmSync, writeFileSync } from "node:fs"
import { cpus, freemem, loadavg, totalmem } from "node:os"
import { dirname, join } from "node:path"
import { performance } from "node:perf_hooks"
import { isDeepStrictEqual } from "node:util"
import type {
	CandidateRead,
	RelationalQuery,
} from "@tanishqkancharla/tandem-core"
import { TandemServer } from "../src/TandemServer.js"
import { TandemServerSqlStorage } from "../src/storage/TandemServerSqlStorage.js"
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
	type BenchDatabase,
	type Dialect,
	type Schema,
} from "./sqlWorkload.js"

const dialect = process.argv[2] as Dialect
const rows = Number(process.argv[3])
const out = process.argv[4]!
const samples = Number(process.argv[5] ?? 15)
const rounds = Number(process.argv[6] ?? 3)
const warmups = 3

type Query = RelationalQuery<Schema, typeof relations>

/** Counts what one query did: statements, rows SQL returned, read outcomes. */
class Counters {
	statements: string[] = []
	rowsDecoded = 0
	pushed = 0
	fallback = 0
	reset() {
		this.statements = []
		this.rowsDecoded = 0
		this.pushed = 0
		this.fallback = 0
	}
}
const counters = new Counters()

/** Records whether each candidate read ran in SQL or fell back to a scan. */
class CountingStorage extends TandemServerSqlStorage<Schema> {
	override async readCandidates(read: CandidateRead) {
		const result = await super.readCandidates(read)
		if (result) counters.pushed++
		else counters.fallback++
		return result
	}
}

const db: BenchDatabase =
	dialect === "sqlite"
		? (() => {
				const path = join(dirname(out), `sqlite-${rows}.db`)
				for (const suffix of ["", "-wal", "-shm"])
					rmSync(path + suffix, { force: true })
				return openSqlite(path)
			})()
		: await openPostgres(process.env.TANDEM_POSTGRES_URL!, `bench_${rows}`)

const host = {
	dialect,
	query: async (statement: TandemSqlStatement) => {
		counters.statements.push(statement.sql)
		const result = await db.query(statement)
		counters.rowsDecoded += result.length
		return result
	},
	commit: db.commit,
}
const storage = new CountingStorage({ schema, ...host })
const native = new TandemServer({ schema, relations, storage })
/** Reads as every query did before SQL reads: whole tables, then filters. */
const fullReads = new TandemServer({
	schema,
	relations,
	storage: {
		scan: (args) => storage.scan(args),
		commit: (writes) => storage.commit(writes),
		close: () => Promise.resolve(),
	},
})

function machine() {
	return {
		at: new Date().toISOString(),
		loadavg: loadavg(),
		freeMemoryBytes: freemem(),
		totalMemoryBytes: totalmem(),
		cpus: cpus().length,
		cpuModel: cpus()[0]?.model,
	}
}

const result: Record<string, unknown> = {
	dialect,
	rows,
	samples,
	rounds,
	warmups,
	node: process.version,
	database: await db.version(),
	commit: execSync("git rev-parse HEAD").toString().trim(),
	dirty: execSync("git status --porcelain -- packages").toString() !== "",
	machineBefore: machine(),
}
const checkpoint = () => {
	mkdirSync(dirname(out), { recursive: true })
	writeFileSync(out, JSON.stringify(result, null, "\t"))
}

// Seed through Tandem's own writes, in batches.
for (const statement of tableDdl(dialect)) await db.exec(statement)
const data = seedData(rows)
const seedStarted = performance.now()
for (const [collection, records] of [
	["users", data.users],
	["threads", data.threads],
	["messages", data.messages],
] as const) {
	for (let index = 0; index < records.length; index += 5000) {
		const tx = native.transact()
		for (const record of records.slice(index, index + 5000))
			tx.set(collection, record as never)
		await native.commit(tx)
	}
}
if (dialect === "postgres") await db.exec("analyze")
result.seedMs = performance.now() - seedStarted
checkpoint()

const threadIds = data.threads.map(({ id }) => id)
const busiest = [
	...Map.groupBy(data.messages, ({ threadId }) => threadId),
].sort((left, right) => right[1].length - left[1].length)[0]![0]
const recentSince = data.messages.at(-Math.min(rows, 500))!.createdAt
const author = data.messages.find(
	({ threadId }) => threadId === busiest,
)!.authorId

/** Realistic list, thread, and recent views, plus controls. */
const workloads: Record<string, Query> = {
	threadPage: {
		collection: "messages",
		where: { threadId: busiest },
		orderBy: { createdAt: "desc" },
		limit: 50,
	},
	threadPageTwo: {
		collection: "messages",
		where: { threadId: busiest },
		orderBy: { createdAt: "desc" },
		limit: 50,
		offset: 50,
	},
	threadAuthor: {
		collection: "messages",
		where: { threadId: busiest, authorId: author },
		orderBy: { createdAt: "desc" },
		limit: 20,
	},
	recent: {
		collection: "messages",
		orderBy: { createdAt: "desc" },
		limit: 20,
	},
	recentSince: {
		collection: "messages",
		where: { createdAt: { gte: recentSince } },
		orderBy: { createdAt: "desc" },
		limit: 50,
	},
	threadWithMessages: {
		collection: "threads",
		where: { id: busiest },
		with: {
			messages: {
				orderBy: { createdAt: "desc" },
				limit: 20,
				with: { author: true },
			},
		},
	},
	threadList: {
		collection: "threads",
		where: { archived: false },
		orderBy: { updatedAt: "desc" },
		limit: 20,
		with: { messages: { orderBy: { createdAt: "desc" }, limit: 3 } },
	},
	// Controls: every row, and a string range SQL leaves to the query engine.
	allRows: { collection: "messages" },
	stringRange: {
		collection: "messages",
		where: { body: { gte: "Message 9" } },
		orderBy: { body: "asc" },
		limit: 20,
	},
}

function countRows(value: unknown): number {
	if (!Array.isArray(value)) return 0
	return value.reduce(
		(count: number, row: Record<string, unknown>) =>
			count +
			1 +
			Object.values(row).reduce(
				(nested: number, field) =>
					nested +
					(Array.isArray(field)
						? countRows(field)
						: field && typeof field === "object"
							? 1
							: 0),
				0,
			),
		0,
	)
}

type Config = "fullReads" | "sql0" | "sql1" | "sql2"
const configs: Config[] = ["fullReads", "sql0", "sql1", "sql2"]
const configIndexes: Record<Config, number> = {
	fullReads: 0,
	sql0: 0,
	sql1: 1,
	sql2: 2,
}

const indexBuilds: unknown[] = []
const indexState = new Set<string>()
async function setIndexes(count: number, round: number) {
	for (const [position, index] of secondaryIndexes.entries()) {
		const wanted = position < count
		if (wanted && !indexState.has(index.name)) {
			const started = performance.now()
			await db.exec(index.sql)
			if (dialect === "postgres") await db.exec(`analyze "messages"`)
			indexBuilds.push({
				round,
				index: index.name,
				buildMs: performance.now() - started,
				bytes: await db.indexBytes(index.name),
			})
			indexState.add(index.name)
		}
		if (!wanted && indexState.has(index.name)) {
			await db.exec(`drop index "${index.name}"`)
			indexState.delete(index.name)
		}
	}
}

const next = random(rows)
function shuffle<T>(values: readonly T[]): T[] {
	const shuffled = [...values]
	for (let index = shuffled.length - 1; index > 0; index--) {
		const other = Math.floor(next() * (index + 1))
		;[shuffled[index], shuffled[other]] = [shuffled[other]!, shuffled[index]!]
	}
	return shuffled
}

const reference = new Map<string, unknown>()
for (const [name, query] of Object.entries(workloads))
	reference.set(name, await fullReads.query(query))

const sampleRows: unknown[] = []
const failures: unknown[] = []
const plans: Record<string, unknown> = {}
result.samplesRaw = sampleRows
result.failures = failures
result.plans = plans
result.indexBuilds = indexBuilds

for (let round = 0; round < rounds; round++) {
	for (const config of shuffle(configs)) {
		await setIndexes(configIndexes[config], round)
		const server = config === "fullReads" ? fullReads : native
		for (const [name, query] of Object.entries(workloads))
			for (let warmup = 0; warmup < warmups; warmup++) await server.query(query)
		const order = shuffle(
			Object.keys(workloads).flatMap((name) =>
				Array.from({ length: samples }, () => name),
			),
		)
		for (const name of order) {
			const query = workloads[name]!
			counters.reset()
			const started = performance.now()
			const value = await server.query(query)
			const ms = performance.now() - started
			const exact = isDeepStrictEqual(value, reference.get(name))
			if (!exact) failures.push({ round, config, workload: name })
			sampleRows.push({
				round,
				config,
				workload: name,
				ms,
				returnedRows: countRows(value),
				rowsDecoded: counters.rowsDecoded,
				statements: counters.statements.length,
				pushed: counters.pushed,
				fallback: counters.fallback,
				exact,
			})
		}
		// Plans of the statements each workload issues under this index set.
		if (round === 0 && config !== "fullReads")
			for (const [name, query] of Object.entries(workloads)) {
				const issued: TandemSqlStatement[] = []
				const recording = new TandemServerSqlStorage<Schema>({
					schema,
					dialect,
					query: (statement) => {
						issued.push(statement)
						return db.query(statement)
					},
					commit: db.commit,
				})
				const server = new TandemServer({
					schema,
					relations,
					storage: recording,
				})
				await server.query(query)
				await server.close()
				plans[`${config}/${name}`] = await Promise.all(
					issued.map(async (statement) => ({
						sql: statement.sql,
						parameters: statement.parameters.length,
						plan: await db.explain(statement),
					})),
				)
			}
		checkpoint()
	}
}

// Write cost: one new message per commit, as a client push does.
const writes: unknown[] = []
result.writes = writes
for (let round = 0; round < rounds; round++)
	for (const indexes of shuffle([0, 1, 2])) {
		await setIndexes(indexes, round)
		const times: number[] = []
		for (let index = 0; index < 100; index++) {
			const tx = native.transact()
			tx.set("messages", {
				id: `write-${round}-${indexes}-${index}`,
				threadId: threadIds[index % threadIds.length]!,
				authorId: "user-000",
				body: "written",
				createdAt: start + rows * 3000 + index,
				pinned: false,
			})
			const started = performance.now()
			await native.commit(tx)
			times.push(performance.now() - started)
		}
		writes.push({ round, indexes, commitMs: times })
		checkpoint()
	}

result.machineAfter = machine()
checkpoint()
await native.close()
await fullReads.close()
await db.close()
console.log(
	`${dialect} ${rows}: ${sampleRows.length} samples, ${failures.length} inexact`,
)
