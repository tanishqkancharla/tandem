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

const schema = defineSchema({
	authors: collection<Author>({ fields: ["id", "name", "rank"] }),
	posts: collection<Post>({
		fields: ["id", "authorId", "score", "title", "tag"],
	}),
	comments: collection<Comment>({ fields: ["id", "postId", "body", "n"] }),
	events: collection<Event>({ fields: ["id", "kind", "n"] }),
})

const relations = defineRelations(schema, ({ one, many }) => ({
	authors: { posts: many("posts", { from: "id", to: "authorId" }) },
	posts: {
		author: one("authors", { from: "authorId", to: "id" }),
		comments: many("comments", { from: "id", to: "postId" }),
	},
	comments: { post: one("posts", { from: "postId", to: "id" }) },
}))

type Records = { [C in keyof PlannerSchema]: PlannerSchema[C][] }
type AnyRecord = Record<string, unknown>
type AnyQuery = {
	collection?: keyof PlannerSchema
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
	return { next, int, pick, chance: (p: number) => next() < p }
}

type Random = ReturnType<typeof random>

function mixedValue(rng: Random) {
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

/** A where value: plain objects would read as operators. */
function whereValue(rng: Random) {
	for (;;) {
		const value = mixedValue(rng)
		if (typeof value !== "object" || value === null || Array.isArray(value))
			return value
	}
}

/** Assigns some fields and leaves others missing. */
function withFields(rng: Random, base: AnyRecord, fields: string[]) {
	const record = { ...base }
	for (const field of fields)
		if (rng.chance(0.85)) record[field] = mixedValue(rng)
	return record
}

function makeRecords(rng: Random): Records {
	const authorIds = Array.from({ length: 6 }, (_, index) => `a${index}`)
	const postIds = Array.from({ length: 14 }, (_, index) => `p${index}`)
	const pickJoin = (ids: string[]) =>
		rng.pick([
			() => rng.pick(ids),
			() => rng.pick(ids),
			() => "missing",
			() => null,
			() => rng.int(3),
		])()
	// The last author's ID is a one-part array. It shares its key with the
	// string ID that posts join on, yet never equals it.
	return {
		authors: authorIds.map(
			(id, index) =>
				withFields(rng, { id: index === 5 ? [id] : id }, [
					"name",
					"rank",
				]) as Author,
		),
		posts: postIds.map(
			(id) =>
				({
					...withFields(rng, { id }, ["score", "title", "tag"]),
					...(rng.chance(0.9) ? { authorId: pickJoin(authorIds) } : {}),
				}) as Post,
		),
		comments: Array.from(
			{ length: 30 },
			(_, index) =>
				({
					...withFields(rng, { id: `c${index}` }, ["body", "n"]),
					...(rng.chance(0.9) ? { postId: pickJoin(postIds) } : {}),
				}) as Comment,
		),
		events: Array.from(
			{ length: 12 },
			(_, index) =>
				withFields(rng, { id: [`d${index % 3}`, index] }, [
					"kind",
					"n",
				]) as Event,
		),
	}
}

const fields: { [C in keyof PlannerSchema]: string[] } = {
	authors: ["id", "name", "rank"],
	posts: ["id", "authorId", "score", "title", "tag"],
	comments: ["id", "postId", "body", "n"],
	events: ["id", "kind", "n"],
}

const includes: {
	[C in keyof PlannerSchema]: Record<string, keyof PlannerSchema>
} = {
	authors: { posts: "posts" },
	posts: { author: "authors", comments: "comments" },
	comments: { post: "posts" },
	events: {},
}

function idValue(
	rng: Random,
	collection: keyof PlannerSchema,
	records: Records,
) {
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
	collection: keyof PlannerSchema,
	records: Records,
	depth: number,
): AnyQuery {
	const query: AnyQuery = {}
	if (rng.chance(0.6)) {
		const where: Record<string, unknown> = {}
		for (const field of fields[collection]) {
			if (!rng.chance(0.35)) continue
			if (field === "id" && rng.chance(0.7)) {
				where.id = idValue(rng, collection, records)
				continue
			}
			where[field] = rng.chance(0.5)
				? whereValue(rng)
				: Object.fromEntries(
						rng
							.pick([["gt"], ["gte"], ["lt"], ["lte"], ["gt", "lte"], ["eq"]])
							.map((op) => [op, whereValue(rng)]),
					)
		}
		query.where = where
	}
	if (rng.chance(0.6)) {
		const orderBy: Record<string, "asc" | "desc"> = {}
		for (const field of fields[collection])
			if (rng.chance(0.4)) orderBy[field] = rng.pick(["asc", "desc"] as const)
		query.orderBy = orderBy
	}
	if (rng.chance(0.4)) query.limit = rng.int(5)
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
					: makeOptions(rng, target, records, depth + 1)
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

function matches(
	record: AnyRecord,
	where: Record<string, unknown> | undefined,
) {
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

function reference(
	records: Records,
	collection: keyof PlannerSchema,
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
				relations as Record<
					string,
					Record<
						string,
						{
							type: string
							from: string
							to: string
							targetCollection: keyof PlannerSchema
						}
					>
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

describe("query planner", () => {
	test.for([1, 2, 3, 4, 5, 6])(
		"matches a scan-everything reference on the client and the server (seed %i)",
		async (seed, { makeRemote }) => {
			const rng = random(seed)
			const records = makeRecords(rng)
			const server = makeRemote({ schema, relations })
			const client = new TandemClient<PlannerSchema, typeof relations>({
				schema,
				relations,
			})
			const serverTx = server.transact()
			const clientTx = client.transact()
			for (const [collection, list] of Object.entries(records))
				for (const record of list) {
					serverTx.set(collection as keyof PlannerSchema, record as never)
					clientTx.set(collection as keyof PlannerSchema, record as never)
				}
			await server.commit(serverTx)
			await client.commit(clientTx)

			for (let index = 0; index < 150; index++) {
				const collection = rng.pick(
					Object.keys(records) as (keyof PlannerSchema)[],
				)
				const query = {
					collection,
					...makeOptions(rng, collection, records, 0),
				} as RelationalQuery<PlannerSchema, typeof relations>
				const expected = reference(records, collection, query as AnyQuery)
				expect(client.query(query), JSON.stringify(query)).toEqual(expected)
				expect(await server.query(query), JSON.stringify(query)).toEqual(
					expected,
				)
			}
		},
	)

	test("equality never matches a value of another type", async ({
		makeRemote,
	}) => {
		const server = makeRemote({ schema, relations })
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

	test("a subscription by ID and through a many-to-one include updates when the record appears", async () => {
		const client = new TandemClient<PlannerSchema, typeof relations>({
			schema,
			relations,
		})
		const byId = vi.fn()
		const withAuthor = vi.fn()
		client.subscribe({ collection: "authors", where: { id: "a1" } }, byId)
		client.subscribe(
			{ collection: "posts", where: { id: "p1" }, with: { author: true } },
			withAuthor,
		)
		const postTx = client.transact()
		postTx.set("posts", { id: "p1", authorId: "a1" })
		await client.commit(postTx)
		expect(withAuthor).toHaveBeenLastCalledWith([
			{ id: "p1", authorId: "a1", author: null },
		])

		// Creating the author reaches both subscriptions, though neither scanned authors.
		const authorTx = client.transact()
		authorTx.set("authors", { id: "a1", name: "Ada" })
		await client.commit(authorTx)
		expect(byId).toHaveBeenLastCalledWith([{ id: "a1", name: "Ada" }])
		expect(withAuthor).toHaveBeenLastCalledWith([
			{ id: "p1", authorId: "a1", author: { id: "a1", name: "Ada" } },
		])
	})
})
