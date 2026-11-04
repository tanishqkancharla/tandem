import {
	collection,
	defineRelations,
	defineSchema,
	tag,
	type ClientId,
} from "@tanishqkancharla/tandem-core"
import type { ScanStorageArgs } from "tuple-database"
import { assert, expect, test as baseTest } from "vitest"
import { TandemServer, type TandemTuple } from "../src/index.js"
import { TestTandemServerStorage } from "./TandemServerStorage.fixture.js"

type Author = { id: string; name: string }
type Post = { id: string; authorId: string; title: string }
type Comment = { id: string; postId: string; body: string }
type BlogSchema = { authors: Author; posts: Post; comments: Comment }

const schema = defineSchema({
	authors: collection<Author>({ fields: ["id", "name"] }),
	posts: collection<Post>({ fields: ["id", "authorId", "title"] }),
	comments: collection<Comment>({ fields: ["id", "postId", "body"] }),
})

const relations = defineRelations(schema, ({ one, many }) => ({
	authors: { posts: many("posts", { from: "id", to: "authorId" }) },
	posts: { author: one("authors", { from: "authorId", to: "id" }) },
	comments: { post: one("posts", { from: "postId", to: "id" }) },
}))

/** Counts the record tuples each storage scan returns. */
class CountingStorage extends TestTandemServerStorage<BlogSchema> {
	recordsRead = 0
	scans = 0

	override async scan(
		args?: ScanStorageArgs,
	): Promise<TandemTuple<BlogSchema>[]> {
		const tuples = await super.scan(args)
		this.scans += 1
		this.recordsRead += tuples.filter(({ key }) => key[0] === "record").length
		return tuples
	}

	reset() {
		this.recordsRead = 0
		this.scans = 0
	}
}

const test = baseTest.extend<{
	storage: CountingStorage
	server: TandemServer<BlogSchema, typeof relations>
}>({
	storage: async ({}, use) => {
		await use(new CountingStorage())
	},
	server: async ({ storage }, use) => {
		const server = new TandemServer({ schema, relations, storage })
		// 50 authors with 10 posts each, and 2,000 comments.
		const tx = server.transact()
		for (let author = 0; author < 50; author++)
			tx.set("authors", { id: `a${author}`, name: `Author ${author}` })
		for (let post = 0; post < 500; post++)
			tx.set("posts", {
				id: `p${post}`,
				authorId: `a${post % 50}`,
				title: `Post ${post}`,
			})
		for (let comment = 0; comment < 2000; comment++)
			tx.set("comments", {
				id: `c${comment}`,
				postId: `p${comment % 500}`,
				body: `Comment ${comment}`,
			})
		await server.commit(tx)
		storage.reset()
		await use(server)
		await server.close()
	},
})

test("a query by full ID reads one record", async ({ server, storage }) => {
	expect(
		await server.query({ collection: "posts", where: { id: "p7" } }),
	).toEqual([{ id: "p7", authorId: "a7", title: "Post 7" }])
	expect(storage.recordsRead).toBe(1)
})

test("a many-to-one include reads each distinct target once, by key", async ({
	server,
	storage,
}) => {
	const posts = await server.query({
		collection: "posts",
		where: { id: "p7" },
		with: { author: true },
	})
	expect(posts).toEqual([
		{
			id: "p7",
			authorId: "a7",
			title: "Post 7",
			author: { id: "a7", name: "Author 7" },
		},
	])
	expect(storage.recordsRead).toBe(2)

	// 120 comments read their posts' distinct IDs by key, not all 500 posts,
	// and those posts' distinct authors.
	storage.reset()
	const comments = await server.query({
		collection: "comments",
		limit: 120,
		with: { post: { with: { author: true } } },
	})
	expect(comments).toHaveLength(120)
	const postIds = new Set(comments.map(({ post }) => post?.id))
	const authorIds = new Set(comments.map(({ post }) => post?.author?.id))
	expect(comments.every(({ postId, post }) => post?.id === postId)).toBe(true)
	expect(postIds.size).toBeLessThan(120)
	expect(storage.recordsRead).toBe(2000 + postIds.size + authorIds.size)
})

test("a one-to-many include reads its target collection once for every parent", async ({
	server,
	storage,
}) => {
	const authors = await server.query({
		collection: "authors",
		with: { posts: { limit: 2 } },
	})
	expect(authors).toHaveLength(50)
	// Each author's first two posts, in key order.
	expect(
		authors.find(({ id }) => id === "a3")?.posts.map(({ id }) => id),
	).toEqual(["p103", "p153"])
	expect(storage.scans).toBe(2)
	expect(storage.recordsRead).toBe(50 + 500)
})

test("a pull runs the same plan, sharing a collection read between queries", async ({
	server,
	storage,
}) => {
	const pulled = await server.pull({
		clientId: tag<ClientId>("reader"),
		scanWindow: [
			{ collection: "posts", where: [["id", "=", "p1"]] },
			{ collection: "authors" },
			{
				collection: "authors",
				where: [["id", "=", "a2"]],
				with: { posts: { collection: "posts", limit: 1 } },
			},
		],
	})
	assert(!("error" in pulled))
	expect(pulled.patch.set).toHaveLength(1 + 50 + 1)
	// One key read for p1, one authors scan that also answers a2, one posts scan.
	expect(storage.recordsRead).toBe(1 + 50 + 500)
})
