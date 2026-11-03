import crypto from "node:crypto"
import type { TandemTuple } from "@tanishqkancharla/tandem-server"
import pg from "pg"
import { InMemoryTupleStorage, MAX, MIN } from "tuple-database"
import type { ScanStorageArgs, Tuple, Value } from "tuple-database"
import { expect, vi } from "vitest"
import { TandemServerPostgresStorage } from "../src/index.js"
import { test } from "./postgres.fixture.js"

type Rng = () => number

// A small seeded generator, so a failing seed can be replayed.
function createRng(seed: number): Rng {
	let state = seed
	return () => {
		state = (state + 0x6d2b79f5) | 0
		let value = Math.imul(state ^ (state >>> 15), 1 | state)
		value ^= value + Math.imul(value ^ (value >>> 7), 61 | value)
		return ((value ^ (value >>> 14)) >>> 0) / 4294967296
	}
}

function pick<T>(rng: Rng, items: readonly T[]): T {
	return items[Math.floor(rng() * items.length)]!
}

// Strings that stress the key encoding: empty, the codec's delimiter and
// escape characters, multi-byte UTF-8, the last BMP unit, a surrogate pair,
// and a lone surrogate.
const strings = [
	"",
	"a",
	"ab",
	"b",
	"record",
	"\x00",
	"a\x00",
	"\x01",
	"a\x01b",
	"é",
	"中文",
	String.fromCharCode(0xffff),
	"😀",
	"\ud800",
]
const numbers = [
	-Infinity,
	-1e21,
	-2.5,
	-1,
	0,
	0.5,
	1,
	2,
	10,
	1e21,
	Number.MAX_SAFE_INTEGER,
	Infinity,
]

function randomValue(rng: Rng, depth: number): Value {
	const kind = pick(rng, [
		"string",
		"string",
		"number",
		"number",
		"boolean",
		"null",
		"array",
		"object",
	])
	if (kind === "string") return pick(rng, strings)
	if (kind === "number") return pick(rng, numbers)
	if (kind === "boolean") return rng() < 0.5
	if (kind === "null" || depth > 1) return null
	if (kind === "array") return randomTuple(rng, depth + 1, 3)
	return { [pick(rng, strings)]: randomValue(rng, depth + 1) }
}

function randomTuple(rng: Rng, depth = 0, maxLength = 4): Tuple {
	const length = Math.floor(rng() * (maxLength + 1))
	return Array.from({ length }, () => randomValue(rng, depth))
}

function randomScanArgs(rng: Rng, keys: Tuple[]): ScanStorageArgs {
	// Bounds are stored keys, prefixes of them, or new tuples, which may end
	// in tuple-database's MIN and MAX markers.
	const bound = () => {
		const key = pick(rng, keys)
		const choice = rng()
		if (choice < 0.4) return key
		if (choice < 0.6) return key.slice(0, Math.floor(rng() * key.length))
		if (choice < 0.8) return [...key, pick(rng, [MIN, MAX])]
		return randomTuple(rng)
	}
	const args: ScanStorageArgs = {}
	if (rng() < 0.7) args[rng() < 0.5 ? "gt" : "gte"] = bound()
	if (rng() < 0.7) args[rng() < 0.5 ? "lt" : "lte"] = bound()
	if (rng() < 0.4) args.limit = 1 + Math.floor(rng() * 5)
	if (rng() < 0.5) args.reverse = true
	return args
}

function scanBothOrReject(
	memory: InMemoryTupleStorage,
	storage: TandemServerPostgresStorage,
	args: ScanStorageArgs,
) {
	const expected = (() => {
		try {
			return memory.scan(args)
		} catch {
			// tuple-database rejects bounds whose start is after their end.
			return "invalid bounds" as const
		}
	})()
	return {
		expected,
		actual: storage.scan(args).catch(() => "invalid bounds" as const),
	}
}

test("scans return tuples in tuple-database order for mixed key types", async ({
	databaseUrl,
}) => {
	const storage = new TandemServerPostgresStorage({
		connectionString: databaseUrl,
	})
	const memory = new InMemoryTupleStorage()
	const keys: Tuple[] = [
		["record", "todos", "a"],
		["record", "todos", "ab"],
		["record", "todos", ""],
		["record", "todos", "😀"],
		["record", "todos", String.fromCharCode(0xffff)],
		["record", "todos", "\ud800"],
		["record", "todos", "a\x00"],
		["record", "todos", "a\x01b"],
		["record", "counts", -1],
		["record", "counts", 0],
		["record", "counts", 2.5],
		["record", "counts", 10],
		["record", "counts", Infinity],
		["record", "entries", ["session-1", 2]],
		["record", "entries", ["session-1", 10]],
		["record", "entries", ["session-1"]],
		["record", "entries", ["session-2", 1]],
		["record", "entries", [["nested"], null]],
		["record", "flags", true],
		["record", "flags", false],
		["record", "flags", null],
		["record", "objects", { a: 1 }],
		["record", "objects", { a: 1, b: 2 }],
		["record"],
		["client", "client-1"],
		[],
	]
	const writes = {
		set: keys.map((key, index) => ({ key, value: { index } })),
	}
	memory.commit(writes)
	await storage.commit(writes as never)

	const scans: ScanStorageArgs[] = [
		{},
		{ reverse: true },
		{ gte: ["record", "todos"], lte: ["record", "todos", MAX] },
		{ gt: ["record", "todos", "a"], lt: ["record", "todos", "😀"] },
		{
			gte: ["record", "entries", ["session-1"]],
			lt: ["record", "entries", ["session-1", MAX]],
		},
		{
			gt: ["record", "counts", -1],
			lte: ["record", "counts", 10],
			reverse: true,
		},
		{ gte: ["record"], limit: 3 },
		{ lt: ["record", "todos", MAX], limit: 4, reverse: true },
		{ gt: ["record", "flags", null], lt: ["record", "flags", true] },
	]
	for (const args of scans) {
		expect(await storage.scan(args), JSON.stringify(args)).toEqual(
			memory.scan(args),
		)
	}
	await storage.close()
})

test("scans match tuple-database for randomized keys and bounds", async ({
	databaseUrl,
}) => {
	const storage = new TandemServerPostgresStorage({
		connectionString: databaseUrl,
	})
	for (const seed of [1, 2, 3]) {
		const rng = createRng(seed)
		const memory = new InMemoryTupleStorage()
		const existing = await storage.scan()
		const keys = Array.from({ length: 300 }, () => randomTuple(rng))
		const writes = {
			set: keys.map((key, index) => ({ key, value: { seed, index } })),
			remove: existing.map(({ key }) => key),
		}
		memory.commit(writes)
		await storage.commit(writes as never)

		expect(await storage.scan(), `seed ${seed}`).toEqual(memory.scan())
		for (let scan = 0; scan < 200; scan++) {
			const args = randomScanArgs(rng, keys)
			const { expected, actual } = scanBothOrReject(memory, storage, args)
			expect(await actual, `seed ${seed}: ${JSON.stringify(args)}`).toEqual(
				expected,
			)
		}
	}
	await storage.close()
})

test("commits apply sets and removes in one batch like tuple-database", async ({
	databaseUrl,
}) => {
	type Schema = { todos: { id: string; title: string } }
	const storage = new TandemServerPostgresStorage<Schema>({
		connectionString: databaseUrl,
	})
	const todo = (id: string, title: string): TandemTuple<Schema> => ({
		key: ["record", "todos", id],
		value: { id, title },
	})
	await storage.commit({
		set: [todo("a", "A"), todo("b", "B"), todo("c", "C")],
	})

	// A key set and removed in one batch stays set, and the last set wins.
	// Removing a missing key does nothing.
	await storage.commit({
		set: [todo("b", "B1"), todo("d", "D"), todo("b", "B2")],
		remove: [
			["record", "todos", "a"],
			["record", "todos", "b"],
			["record", "todos", "missing"],
		],
	})
	expect(await storage.scan()).toEqual([
		todo("b", "B2"),
		todo("c", "C"),
		todo("d", "D"),
	])

	// An empty commit changes nothing.
	await storage.commit({})
	await storage.commit({ set: [], remove: [] })
	expect(await storage.scan()).toEqual([
		todo("b", "B2"),
		todo("c", "C"),
		todo("d", "D"),
	])

	// Batches larger than one SQL statement commit together.
	const many = Array.from({ length: 2500 }, (_, index) =>
		todo(`bulk-${String(index).padStart(4, "0")}`, `Bulk ${index}`),
	)
	await storage.commit({ set: many })
	await storage.commit({ remove: many.slice(0, 2400).map(({ key }) => key) })
	expect(
		await storage.scan({
			gte: ["record", "todos", "bulk-"],
			lt: ["record", "todos", "bulk-~"],
		}),
	).toEqual(many.slice(2400))
	await storage.close()
})

test("commits reject as a whole when a key is too long to index", async ({
	databaseUrl,
}) => {
	const storage = new TandemServerPostgresStorage({
		connectionString: databaseUrl,
	})
	const note = (id: string, n: number) => ({
		key: ["record", "notes", id] as ["record", string, string],
		value: { id, n },
	})
	await storage.commit({ set: [note("a", 1)] })

	// Postgres caps index entries at about 2.7 kB, so the long key fails and
	// the valid writes in the same commit do not apply.
	const longId = crypto.randomBytes(8000).toString("base64")
	await expect(
		storage.commit({
			set: [note("a", 2), note(longId, 3)],
			remove: [["record", "notes", "a"]],
		}),
	).rejects.toThrow("Tandem server Postgres storage failed to commit")
	expect(await storage.scan()).toEqual([note("a", 1)])
	await storage.close()
})

test("values keep their field order and any string content", async ({
	databaseUrl,
}) => {
	const storage = new TandemServerPostgresStorage({
		connectionString: databaseUrl,
	})
	const value = {
		zeta: "\u0000 and \ud800",
		alpha: [1.5, null, { nested: "😀" }],
		id: "x",
	}
	await storage.commit({ set: [{ key: ["record", "notes", "x"], value }] })

	const [stored] = await storage.scan()
	expect(stored?.value).toEqual(value)
	expect(Object.keys(stored?.value as object)).toEqual(["zeta", "alpha", "id"])
	await storage.close()
})

test("subscribers hear commits from other storage instances once readable", async ({
	databaseUrl,
}) => {
	const storage = new TandemServerPostgresStorage({
		connectionString: databaseUrl,
	})
	const pool = new pg.Pool({ connectionString: databaseUrl })
	const other = new TandemServerPostgresStorage({ pool })
	const changes: { key: Tuple; value: unknown }[][] = []
	let changed = Promise.withResolvers<void>()
	const unsubscribe = storage.subscribe(() => {
		void storage.scan().then((tuples) => {
			changes.push(tuples)
			changed.resolve()
			changed = Promise.withResolvers<void>()
		})
	})

	// The first call says the storage is listening, since it may have missed
	// earlier commits.
	await changed.promise
	expect(changes).toEqual([[]])

	// The subscriber's own commits do not call it; another instance's do, after
	// the commit is visible to scans.
	const next = changed.promise
	const own = { id: "own" }
	const external = { id: "other" }
	await storage.commit({
		set: [{ key: ["record", "notes", "own"], value: own }],
	})
	await other.commit({
		set: [{ key: ["record", "notes", "other"], value: external }],
	})
	await next
	expect(changes).toEqual([
		[],
		[
			{ key: ["record", "notes", "other"], value: external },
			{ key: ["record", "notes", "own"], value: own },
		],
	])

	unsubscribe()
	await storage.close()
	// Closing a storage built on an app's pool leaves the pool open.
	await other.close()
	expect(await pool.query("select 1 as one")).toMatchObject({
		rows: [{ one: 1 }],
	})
	await pool.end()
})

test("subscribers hear commits again after the listening connection drops", async ({
	databaseUrl,
}) => {
	const storage = new TandemServerPostgresStorage({
		connectionString: databaseUrl,
	})
	const other = new TandemServerPostgresStorage({
		connectionString: databaseUrl,
	})
	let calls = 0
	let called = Promise.withResolvers<void>()
	const unsubscribe = storage.subscribe(() => {
		calls += 1
		called.resolve()
		called = Promise.withResolvers<void>()
	})
	await called.promise

	// Postgres ends the listening connection, as on a restart or failover. The
	// storage listens again and calls subscribers, since it may have missed
	// commits in between.
	const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
	const admin = new pg.Client({ connectionString: databaseUrl })
	await admin.connect()
	await admin.query(
		`select pg_terminate_backend(pid) from pg_stat_activity
		where datname = current_database() and query like 'LISTEN%'`,
	)
	await admin.end()
	await called.promise
	expect(calls).toBe(2)
	expect(warn).toHaveBeenCalled()
	warn.mockRestore()

	const next = called.promise
	await other.commit({
		set: [{ key: ["record", "notes", "after"], value: { id: "after" } }],
	})
	await next
	expect(calls).toBe(3)

	unsubscribe()
	await storage.close()
	await other.close()
})
