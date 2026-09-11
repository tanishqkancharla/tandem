import {
	collection,
	defineRelations,
	defineSchema,
} from "@tanishqkancharla/tandem-core"
import { expect, expectTypeOf, test } from "vitest"
import { TandemServer } from "../src"
import { TestTandemServerStorage } from "./TandemServerStorage.fixture"

type User = {
	id: string
	name: string
}

type Thread = {
	id: string
	ownerId: string
	title: string
	status: "open" | "closed"
	createdAt: number
}

type Message = {
	id: string
	threadId: string
	body: string
	createdAt: number
}

type TestSchema = {
	users: User
	threads: Thread
	messages: Message
}

const schema = defineSchema({
	users: collection<User>({ fields: ["id", "name"] }),
	threads: collection<Thread>({
		fields: ["id", "ownerId", "title", "status", "createdAt"],
	}),
	messages: collection<Message>({
		fields: ["id", "threadId", "body", "createdAt"],
	}),
})

const relations = defineRelations(schema, ({ one, many }) => ({
	users: {
		threads: many("threads", { from: "id", to: "ownerId" }),
	},
	threads: {
		owner: one("users", { from: "ownerId", to: "id" }),
		messages: many("messages", { from: "id", to: "threadId" }),
	},
	messages: {
		thread: one("threads", { from: "threadId", to: "id" }),
	},
}))

type TestRelations = typeof relations

function createServer() {
	const storage = new TestTandemServerStorage<TestSchema>()
	const server = new TandemServer({ schema, relations, storage })
	return { server, storage }
}

async function seed(server: TandemServer<TestSchema, TestRelations>) {
	const tx = server.transact()
	tx.set("users", { id: "user-1", name: "Ada" })
	tx.set("threads", {
		id: "thread-1",
		ownerId: "user-1",
		title: "Alpha",
		status: "open",
		createdAt: 1,
	})
	tx.set("threads", {
		id: "thread-2",
		ownerId: "user-1",
		title: "Zulu",
		status: "closed",
		createdAt: 2,
	})
	tx.set("threads", {
		id: "thread-3",
		ownerId: "user-1",
		title: "Bravo",
		status: "open",
		createdAt: 3,
	})
	tx.set("messages", {
		id: "message-1",
		threadId: "thread-1",
		body: "First",
		createdAt: 1,
	})
	tx.set("messages", {
		id: "message-2",
		threadId: "thread-1",
		body: "Latest",
		createdAt: 2,
	})
	await server.commit(tx)
}

test("transactions provide typed CRUD and read their staged writes", async () => {
	const { server, storage } = createServer()
	const tx = server.transact()

	tx.set("threads", {
		id: "thread-1",
		ownerId: "user-1",
		title: "Draft",
		status: "open",
		createdAt: 1,
	})
	expect(await tx.get("threads", "thread-1")).toEqual({
		id: "thread-1",
		ownerId: "user-1",
		title: "Draft",
		status: "open",
		createdAt: 1,
	})
	expect(await tx.list("threads")).toHaveLength(1)
	await tx.update("threads", "thread-1", (thread) => ({
		...thread,
		title: "Published",
	}))
	await server.commit(tx)

	const verify = server.transact()
	expect(await verify.get("threads", "thread-1")).toMatchObject({
		title: "Published",
	})
	verify.remove("threads", "thread-1")
	expect(await verify.get("threads", "thread-1")).toBeUndefined()
	await verify.cancel()

	await server.close()
	expect(storage.closed).toBe(true)
})

test("transaction queries include staged records and relations", async () => {
	const { server } = createServer()
	const tx = server.transact()

	tx.set("users", { id: "user-1", name: "Ada" })
	tx.set("threads", {
		id: "thread-1",
		ownerId: "user-1",
		title: "Draft",
		status: "open",
		createdAt: 1,
	})

	const result = await tx.query({
		collection: "threads",
		select: { title: true },
		with: { owner: { select: { name: true } } },
	})
	expect(result).toEqual([{ title: "Draft", owner: { name: "Ada" } }])
	expect(await server.query({ collection: "threads" })).toEqual([])
	await tx.cancel()
	await server.close()
})

test("commit rejects on storage and concurrent read/write conflicts", async () => {
	const { server, storage } = createServer()
	await seed(server)

	const reader = server.transact()
	await reader.get("threads", "thread-1")

	const writer = server.transact()
	writer.set("threads", {
		id: "thread-1",
		ownerId: "user-1",
		title: "Writer",
		status: "open",
		createdAt: 1,
	})
	await server.commit(writer)

	reader.set("threads", {
		id: "thread-1",
		ownerId: "user-1",
		title: "Reader",
		status: "open",
		createdAt: 1,
	})
	await expect(server.commit(reader)).rejects.toThrow(
		"Tandem server commit failed",
	)

	const failing = server.transact()
	failing.set("users", { id: "user-2", name: "Grace" })
	const storageCause = new Error("storage unavailable")
	storage.failNextCommit(storageCause)
	await expect(server.commit(failing)).rejects.toMatchObject({
		cause: storageCause,
	})
})

test("query supports scalar options and nested relations", async () => {
	const { server } = createServer()
	await seed(server)

	const page = await server.query({
		collection: "threads",
		where: { status: "open" },
		orderBy: { createdAt: "desc" },
		offset: 1,
		limit: 1,
		select: { id: true, title: true },
	})
	expect(page).toEqual([{ id: "thread-1", title: "Alpha" }])
	expectTypeOf(page).toMatchTypeOf<{ id: string; title: string }[]>()

	const nested = await server.query({
		collection: "users",
		select: { name: true },
		with: {
			threads: {
				where: { status: "open" },
				select: { title: true },
				orderBy: { createdAt: "asc" },
				with: {
					messages: {
						select: { body: true },
						orderBy: { createdAt: "desc" },
					},
				},
			},
		},
	})
	expect(nested).toEqual([
		{
			name: "Ada",
			threads: [
				{
					title: "Alpha",
					messages: [{ body: "Latest" }, { body: "First" }],
				},
				{ title: "Bravo", messages: [] },
			],
		},
	])

	const withOwner = await server.query({
		collection: "threads",
		where: { id: "thread-1" },
		select: { id: true },
		with: { owner: { select: { name: true } } },
	})
	expect(withOwner).toEqual([{ id: "thread-1", owner: { name: "Ada" } }])
})

test("subscriptions recompute for root and included records until destroyed", async () => {
	const { server } = createServer()
	await seed(server)
	const results: unknown[] = []
	const subscription = await server.subscribe(
		{
			collection: "threads",
			where: { id: "thread-1" },
			select: { title: true },
			with: { messages: { select: { body: true } } },
		},
		(result) => results.push(result),
	)

	expect(subscription.result).toEqual([
		{
			title: "Alpha",
			messages: [{ body: "First" }, { body: "Latest" }],
		},
	])

	const rootUpdate = server.transact()
	await rootUpdate.update("threads", "thread-1", (thread) => ({
		...thread,
		title: "Updated",
	}))
	await server.commit(rootUpdate)
	expect(results.at(-1)).toMatchObject([{ title: "Updated" }])

	const includedUpdate = server.transact()
	await includedUpdate.update("messages", "message-1", (message) => ({
		...message,
		body: "Edited",
	}))
	await server.commit(includedUpdate)
	expect(results.at(-1)).toMatchObject([
		{ messages: [{ body: "Edited" }, { body: "Latest" }] },
	])

	const resultCount = results.length
	subscription.destroy()
	const afterDestroy = server.transact()
	await afterDestroy.update("threads", "thread-1", (thread) => ({
		...thread,
		title: "Ignored",
	}))
	await server.commit(afterDestroy)
	expect(results).toHaveLength(resultCount)
})

test("subscriptions reject initial reads and report recomputation failures", async () => {
	const { server, storage } = createServer()
	await seed(server)
	storage.failNextScan(new Error("initial read failed"))
	const initialCallbacks: unknown[] = []
	await expect(
		server.subscribe({ collection: "threads" }, (result) =>
			initialCallbacks.push(result),
		),
	).rejects.toThrow("Tandem server subscribe failed")

	const callbacks: unknown[] = []
	const errors: Error[] = []
	const subscription = await server.subscribe(
		{ collection: "threads" },
		(result) => callbacks.push(result),
		{ onError: (error) => errors.push(error) },
	)
	storage.failNextScan(new Error("recompute failed"))
	const update = server.transact()
	update.set("threads", {
		id: "thread-1",
		ownerId: "user-1",
		title: "Triggers recompute",
		status: "open",
		createdAt: 1,
	})
	await server.commit(update)
	expect(errors.at(-1)).toBeInstanceOf(Error)

	const callbackCount = callbacks.length
	await server.close()
	expect(storage.closed).toBe(true)
	const afterClose = server.transact()
	afterClose.set("users", { id: "user-2", name: "Grace" })
	await server.commit(afterClose)
	subscription.destroy()
	expect(callbacks).toHaveLength(callbackCount)
	expect(initialCallbacks).toEqual([])
})
