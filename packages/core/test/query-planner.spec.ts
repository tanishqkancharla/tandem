import {
	collection,
	defineRelations,
	defineSchema,
	TandemClient,
	type CollectionId,
	type RelationalQuery,
} from "@tanishqkancharla/tandem-core"
import { collectionIdToTuple } from "@tanishqkancharla/tandem-core/internal"
import { compareTuple } from "tuple-database/helpers/compareTuple.js"
import { describe, expect, vi } from "vitest"
import { test } from "./fixtures.js"

// Field values deliberately mix types, nulls, and missing fields.
type Author = { id: string; name?: unknown; rank?: unknown }
type Post = {
	id: string
	authorId?: unknown
	score?: unknown
	title?: unknown
	tag?: unknown
}
type Comment = { id: string; postId?: unknown; body?: unknown; n?: unknown }
type Event = { id: readonly [string, number]; kind?: unknown; n?: unknown }
type PlannerSchema = {
	authors: Author
	posts: Post
	comments: Comment
	events: Event
}
type Collection = keyof PlannerSchema

const fields: { [C in Collection]: string[] } = {
	authors: ["id", "name", "rank"],
	posts: ["id", "authorId", "score", "title", "tag"],
	comments: ["id", "postId", "body", "n"],
	events: ["id", "kind", "n"],
}

const plainSchema = defineSchema({
	authors: collection<Author>({ fields: ["id", "name", "rank"] }),
	posts: collection<Post>({
		fields: ["id", "authorId", "score", "title", "tag"],
	}),
	comments: collection<Comment>({ fields: ["id", "postId", "body", "n"] }),
	events: collection<Event>({ fields: ["id", "kind", "n"] }),
})

const indexedSchema = defineSchema({
	authors: collection<Author>({
		fields: ["id", "name", "rank"],
		indexes: { byRank: ["rank"] },
	}),
	posts: collection<Post>({
		fields: ["id", "authorId", "score", "title", "tag"],
		indexes: {
			byAuthor: ["authorId", "score"],
			byScore: ["score"],
			byTag: ["tag", "title"],
		},
	}),
	comments: collection<Comment>({
		fields: ["id", "postId", "body", "n"],
		indexes: { byPost: ["postId", "n"] },
	}),
	events: collection<Event>({
		fields: ["id", "kind", "n"],
		indexes: { byKind: ["kind", "n"] },
	}),
})

const relations = defineRelations(plainSchema, ({ one, many }) => ({
	authors: { posts: many("posts", { from: "id", to: "authorId" }) },
	posts: {
		author: one("authors", { from: "authorId", to: "id" }),
		comments: many("comments", { from: "id", to: "postId" }),
	},
	comments: { post: one("posts", { from: "postId", to: "id" }) },
}))

const includes: { [C in Collection]: Record<string, Collection> } = {
	authors: { posts: "posts" },
	posts: { author: "authors", comments: "comments" },
	comments: { post: "posts" },
	events: {},
}

type Records = { [C in Collection]: PlannerSchema[C][] }
type AnyRecord = Record<string, unknown>
type AnyQuery = {
	where?: Record<string, unknown>
	orderBy?: Record<string, "asc" | "desc">
	limit?: number
	offset?: number
	select?: Record<string, true>
	with?: Record<string, true | AnyQuery>
}

/** A small deterministic generator, so a failing seed reproduces. */
function random(seed: number) {
	let state = seed >>> 0
	const next = () => {
		state = (state + 0x6d2b79f5) >>> 0
		let t = state
		t = Math.imul(t ^ (t >>> 15), t | 1)
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296
	}
	const int = (max: number) => Math.floor(next() * max)
	const pick = <T>(items: readonly T[]) => items[int(items.length)]!
	return { int, pick, chance: (p: number) => next() < p }
}

type Random = ReturnType<typeof random>

/**
 * Mixed data holds any type in any field. Uniform data gives each field one
 * type, so index ranges and ordered reads apply instead of falling back.
 */
type Profile = "mixed" | "uniform"

const textFields = new Set(["name", "title", "tag", "kind", "body"])

function fieldValue(rng: Random, profile: Profile, field: string) {
	if (profile === "uniform")
		return textFields.has(field) ? `v${rng.int(6)}` : rng.int(8)
	return rng.pick([
		() => rng.int(5),
		() => rng.int(5) - 2.5,
		() => `v${rng.int(5)}`,
		() => String(rng.int(5)),
		() => null,
		() => rng.chance(0.5),
		() => [rng.int(3)],
		() => ({ k: rng.int(2) }),
	])()
}

/** A where value of the field's kind; plain objects would read as operators. */
function whereValue(rng: Random, profile: Profile, field: string) {
	for (;;) {
		const value = fieldValue(rng, profile, field)
		if (typeof value !== "object" || value === null || Array.isArray(value))
			return value
	}
}

const joinTargets = {
	authorId: Array.from({ length: 6 }, (_, index) => `a${index}`),
	postId: Array.from({ length: 14 }, (_, index) => `p${index}`),
}

const counts: Record<Collection, number> = {
	authors: 6,
	posts: 14,
	comments: 30,
	events: 12,
}

function recordId(collection: Collection, index: number): unknown {
	switch (collection) {
		case "authors":
			// The last author's ID is a one-part array. It shares its key with
			// the string ID that posts join on, yet never equals it.
			return index === 5 ? [`a${index}`] : `a${index}`
		case "posts":
			return `p${index}`
		case "comments":
			return `c${index}`
		case "events":
			return [`d${index % 3}`, index]
	}
}

function makeRecord(
	rng: Random,
	profile: Profile,
	collection: Collection,
	index: number,
): AnyRecord {
	const record: AnyRecord = { id: recordId(collection, index) }
	for (const field of fields[collection].slice(1)) {
		if (profile === "mixed" && !rng.chance(0.85)) continue
		record[field] =
			field === "authorId" || field === "postId"
				? rng.pick([
						() => rng.pick(joinTargets[field]),
						() => rng.pick(joinTargets[field]),
						() => "missing",
						() => (profile === "mixed" ? null : "none"),
					])()
				: fieldValue(rng, profile, field)
	}
	return record
}

function makeRecords(rng: Random, profile: Profile): Records {
	const records = {} as Record<Collection, AnyRecord[]>
	for (const collection of Object.keys(counts) as Collection[])
		records[collection] = Array.from(
			{ length: counts[collection] },
			(_, index) => makeRecord(rng, profile, collection, index),
		)
	return records as unknown as Records
}

function idValue(rng: Random, collection: Collection, records: Records) {
	const existing = rng.pick<{ id: unknown }>(records[collection]).id
	return rng.pick([
		() => existing,
		() => existing,
		() => (Array.isArray(existing) ? [...existing] : `${existing}x`),
		() => (Array.isArray(existing) ? existing[0] : [existing]),
		() => 1,
	])()
}

function makeOptions(
	rng: Random,
	profile: Profile,
	collection: Collection,
	records: Records,
	depth: number,
): AnyQuery {
	const query: AnyQuery = {}
	if (rng.chance(0.7)) {
		const where: Record<string, unknown> = {}
		for (const field of fields[collection]) {
			if (!rng.chance(0.4)) continue
			if (field === "id") {
				if (rng.chance(0.5)) where.id = idValue(rng, collection, records)
				continue
			}
			if (field === "authorId" || field === "postId") {
				where[field] = rng.pick(joinTargets[field])
				continue
			}
			where[field] = rng.chance(0.5)
				? whereValue(rng, profile, field)
				: Object.fromEntries(
						rng
							.pick([["gt"], ["gte"], ["lt"], ["lte"], ["gt", "lte"], ["eq"]])
							.map((op) => [op, whereValue(rng, profile, field)]),
					)
		}
		query.where = where
	}
	if (rng.chance(0.7)) {
		const ordered = fields[collection].filter(() => rng.chance(0.35))
		query.orderBy = Object.fromEntries(
			(rng.chance(0.5) ? ordered.slice(0, 1) : ordered).map((field) => [
				field,
				rng.pick(["asc", "desc"] as const),
			]),
		)
	}
	if (rng.chance(0.5)) query.limit = rng.int(5)
	if (rng.chance(0.3)) query.offset = rng.int(4)
	if (rng.chance(0.25))
		query.select = Object.fromEntries(
			fields[collection]
				.filter(() => rng.chance(0.5))
				.map((field) => [field, true]),
		) as Record<string, true>
	if (depth < 2 && rng.chance(0.6)) {
		const nested: Record<string, true | AnyQuery> = {}
		for (const [name, target] of Object.entries(includes[collection]))
			if (rng.chance(0.6))
				nested[name] = rng.chance(0.3)
					? true
					: makeOptions(rng, profile, target, records, depth + 1)
		query.with = nested
	}
	return query
}

// The reference: scan everything, then filter, sort, page, and join per row.

function compareOrdered(left: unknown, right: unknown) {
	if (typeof left === "number" && typeof right === "number")
		return left > right ? 1 : left < right ? -1 : 0
	if (typeof left === "string" && typeof right === "string")
		return left > right ? 1 : left < right ? -1 : 0
	return 0
}

function equals(left: unknown, right: unknown) {
	if (left === right) return true
	return (
		typeof left === "object" &&
		left !== null &&
		typeof right === "object" &&
		right !== null &&
		JSON.stringify(left) === JSON.stringify(right)
	)
}

function matches(record: AnyRecord, where: AnyQuery["where"]) {
	return Object.entries(where ?? {}).every(([field, condition]) => {
		if (condition === undefined) return true
		const value = record[field]
		if (
			typeof condition !== "object" ||
			condition === null ||
			Array.isArray(condition)
		)
			return equals(value, condition)
		return Object.entries(condition).every(([operator, bound]) => {
			if (bound === undefined) return true
			const comparison = compareOrdered(value, bound)
			switch (operator) {
				case "eq":
					return equals(value, bound)
				case "gt":
					return comparison > 0
				case "gte":
					return comparison >= 0
				case "lt":
					return comparison < 0
				case "lte":
					return comparison <= 0
				default:
					throw new Error(operator)
			}
		})
	})
}

function inKeyOrder(records: readonly AnyRecord[]) {
	return [...records].sort((left, right) =>
		compareTuple(
			collectionIdToTuple(left.id as CollectionId),
			collectionIdToTuple(right.id as CollectionId),
		),
	)
}

type ReferenceRelation = {
	type: string
	from: string
	to: string
	targetCollection: Collection
}

function reference(
	records: Records,
	collection: Collection,
	query: AnyQuery,
	candidates: readonly AnyRecord[] = inKeyOrder(records[collection]),
): AnyRecord[] {
	const rows = candidates.filter((record) => matches(record, query.where))
	rows.sort((left, right) => {
		for (const [field, direction] of Object.entries(query.orderBy ?? {})) {
			const comparison = compareOrdered(left[field], right[field])
			if (comparison !== 0)
				return direction === "asc" ? comparison : -comparison
		}
		return 0
	})
	const paged = rows.slice(query.offset ?? 0).slice(0, query.limit ?? Infinity)
	return paged.map((row) => {
		const result: AnyRecord = query.select
			? Object.fromEntries(
					Object.keys(query.select)
						.filter((field) => field in row)
						.map((field) => [field, row[field]]),
				)
			: { ...row }
		for (const [name, include] of Object.entries(query.with ?? {})) {
			const relation = (
				relations as unknown as Record<
					string,
					Record<string, ReferenceRelation>
				>
			)[collection]![name]!
			const nested = include === true ? {} : include
			const related = inKeyOrder(records[relation.targetCollection]).filter(
				(target) => target[relation.to] === row[relation.from],
			)
			const joined = reference(
				records,
				relation.targetCollection,
				nested,
				related,
			)
			result[name] =
				relation.type === "many-to-one" ? (joined[0] ?? null) : joined
		}
		return result
	})
}

type Write =
	| { type: "set"; collection: Collection; value: AnyRecord }
	| { type: "remove"; collection: Collection; id: unknown }

/** One random write, applied to the reference records. */
function randomWrite(rng: Random, profile: Profile, records: Records): Write {
	const collection = rng.pick(Object.keys(records) as Collection[])
	const list = records[collection] as unknown as AnyRecord[]
	const index = rng.int(counts[collection])
	const id = recordId(collection, index)
	const existing = list.findIndex((record) => equals(record.id, id))
	if (existing !== -1 && rng.chance(0.25)) {
		list.splice(existing, 1)
		return { type: "remove", collection, id }
	}
	const value = makeRecord(rng, profile, collection, index)
	if (existing === -1) list.push(value)
	else list[existing] = value
	return { type: "set", collection, value }
}

describe("query planner", () => {
	test.for(
		[1, 2, 3, 4, 5, 6].flatMap((seed) =>
			(["mixed", "uniform"] as const).flatMap((profile) =>
				(["plain", "indexed"] as const).map((schemaKind) => ({
					seed,
					profile,
					schemaKind,
				})),
			),
		),
	)(
		"matches a scan-everything reference on the client and server through writes and a reopen ($profile data, $schemaKind schema, seed $seed)",
		async ({ seed, profile, schemaKind }, { makeRemote, makeStorage }) => {
			const schema = schemaKind === "indexed" ? indexedSchema : plainSchema
			const rng = random(seed)
			const records = makeRecords(rng, profile)
			const server = makeRemote({ schema, relations })
			const storage = makeStorage<PlannerSchema>({ schema })
			const createClient = () =>
				new TandemClient<PlannerSchema, typeof relations>({
					schema,
					relations,
					clientStorage: storage,
					clientStorageWriteInterval: 0,
				})
			let client = createClient()
			await client.ready
			const apply = async (writes: readonly Write[]) => {
				const clientTx = client.transact()
				const serverTx = server.transact()
				for (const write of writes)
					for (const tx of [clientTx, serverTx])
						if (write.type === "set")
							tx.set(write.collection, write.value as never)
						else tx.remove(write.collection, write.id as never)
				await client.commit(clientTx)
				await server.commit(serverTx)
			}
			await apply(
				Object.entries(records).flatMap(([collection, list]) =>
					(list as AnyRecord[]).map((value): Write => ({
						type: "set",
						collection: collection as Collection,
						value,
					})),
				),
			)

			const check = async (count: number) => {
				for (let index = 0; index < count; index++) {
					const collection = rng.pick(Object.keys(records) as Collection[])
					const options = makeOptions(rng, profile, collection, records, 0)
					const query = {
						collection,
						...options,
					} as RelationalQuery<PlannerSchema, typeof relations>
					const expected = reference(records, collection, options)
					const label = JSON.stringify(query)
					expect(client.query(query), label).toEqual(expected)
					expect(await server.query(query), label).toEqual(expected)
				}
			}
			await check(60)

			// Writes move entries; results follow.
			for (let round = 0; round < 4; round++) {
				await apply(
					Array.from({ length: 6 }, () => randomWrite(rng, profile, records)),
				)
				await check(25)
			}

			// A reopened client rebuilds its entries from storage.
			await client.flushClientStorage()
			client = createClient()
			await client.ready
			await check(40)
		},
	)

	test("equality never matches a value of another type", async ({
		makeRemote,
	}) => {
		const server = makeRemote({ schema: plainSchema, relations })
		const tx = server.transact()
		tx.set("posts", { id: "p1", score: 1, tag: "" })
		tx.set("posts", { id: "p2", score: "1", tag: 0 })
		tx.set("posts", { id: "p3", tag: null })
		await server.commit(tx)

		// Before, `0 == ""`, `1 == "1"`, and `null == undefined` matched.
		expect(
			await server.query({ collection: "posts", where: { score: 1 } }),
		).toEqual([{ id: "p1", score: 1, tag: "" }])
		expect(
			await server.query({ collection: "posts", where: { tag: 0 } }),
		).toEqual([{ id: "p2", score: "1", tag: 0 }])
		expect(
			await server.query({ collection: "posts", where: { tag: null } }),
		).toEqual([{ id: "p3", tag: null }])
		// An undefined condition adds no filter, as in a subscription's window.
		expect(
			await server.query({ collection: "posts", where: { tag: undefined } }),
		).toHaveLength(3)
	})

	test.for(["plain", "indexed"] as const)(
		"subscriptions by ID, through includes, and by an indexed filter update as records appear (%s schema)",
		async (schemaKind) => {
			const schema = schemaKind === "indexed" ? indexedSchema : plainSchema
			const client = new TandemClient<PlannerSchema, typeof relations>({
				schema,
				relations,
			})
			const byId = vi.fn()
			const withRelated = vi.fn()
			const topScore = vi.fn()
			client.subscribe({ collection: "authors", where: { id: "a1" } }, byId)
			client.subscribe(
				{
					collection: "posts",
					where: { id: "p1" },
					with: { author: true, comments: true },
				},
				withRelated,
			)
			client.subscribe(
				{
					collection: "posts",
					where: { authorId: "a1" },
					orderBy: { score: "desc" },
					limit: 1,
				},
				topScore,
			)
			const postTx = client.transact()
			postTx.set("posts", { id: "p1", authorId: "a1", score: 1 })
			await client.commit(postTx)
			expect(withRelated).toHaveBeenLastCalledWith([
				{ id: "p1", authorId: "a1", score: 1, author: null, comments: [] },
			])
			expect(topScore).toHaveBeenLastCalledWith([
				{ id: "p1", authorId: "a1", score: 1 },
			])

			// Each new record reaches the subscriptions that read it.
			const nextTx = client.transact()
			nextTx.set("authors", { id: "a1", name: "Ada" })
			nextTx.set("comments", { id: "c1", postId: "p1", n: 1 })
			nextTx.set("posts", { id: "p2", authorId: "a1", score: 5 })
			await client.commit(nextTx)
			expect(byId).toHaveBeenLastCalledWith([{ id: "a1", name: "Ada" }])
			expect(withRelated).toHaveBeenLastCalledWith([
				{
					id: "p1",
					authorId: "a1",
					score: 1,
					author: { id: "a1", name: "Ada" },
					comments: [{ id: "c1", postId: "p1", n: 1 }],
				},
			])
			expect(topScore).toHaveBeenLastCalledWith([
				{ id: "p2", authorId: "a1", score: 5 },
			])
		},
	)
})
