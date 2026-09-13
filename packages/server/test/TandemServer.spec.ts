import {
	collection,
	defineRelations,
	defineSchema,
	tag,
} from "@tanishqkancharla/tandem-core"
import type {
	ClientId,
	MutationId,
	Patch,
	RemoteApi,
	ScanWindow,
} from "@tanishqkancharla/tandem-core"
import { expect, expectTypeOf, test, vi } from "vitest"
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

function patchSetKeys(patch: Patch<TestSchema>) {
	return (patch.set ?? [])
		.map((operation) => `${operation.collection}.${operation.value.id}`)
		.toSorted()
}

function patchRemoveKeys(patch: Patch<TestSchema>) {
	return (patch.remove ?? [])
		.map((operation) => `${operation.collection}.${operation.id}`)
		.toSorted()
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

test("remote pushes preserve operation order and acknowledge the last mutation once", async () => {
	const { server } = createServer()
	const clientId = tag<ClientId>("offline-client")
	const duplicateMutationId = tag<MutationId>("duplicate-mutation")
	const scanWindow: ScanWindow<TestSchema> = [{ collection: "threads" }]
	const initial = await server.pull({ clientId, scanWindow })
	const mutations: Parameters<RemoteApi<TestSchema>["push"]>[0]["mutations"] = [
		{
			id: duplicateMutationId,
			ops: [
				{
					type: "set",
					collection: "threads",
					value: {
						id: "thread-1",
						ownerId: "user-1",
						title: "First",
						status: "open",
						createdAt: 1,
					},
				},
			],
		},
		{
			id: duplicateMutationId,
			ops: [
				{
					type: "set",
					collection: "threads",
					value: {
						id: "thread-1",
						ownerId: "user-1",
						title: "Last write wins",
						status: "open",
						createdAt: 2,
					},
				},
				{
					type: "set",
					collection: "threads",
					value: {
						id: "thread-2",
						ownerId: "user-1",
						title: "Removed in batch",
						status: "open",
						createdAt: 3,
					},
				},
				{ type: "remove", collection: "threads", id: "thread-2" },
			],
		},
	]

	// Push and pull work without a prior connect registration.
	expect(initial.cookie).toBe(0)
	await server.push({ clientId, mutations })
	const acknowledged = await server.pull({
		clientId,
		cookie: initial.cookie,
		scanWindow,
	})
	expect(acknowledged.lastMutationId).toBe(duplicateMutationId)
	expect(acknowledged.cookie).toBe(1)
	expect(acknowledged.patch.set).toEqual([
		{
			collection: "threads",
			value: {
				id: "thread-1",
				ownerId: "user-1",
				title: "Last write wins",
				status: "open",
				createdAt: 2,
			},
		},
	])

	// Acknowledgements are consumed and unchanged pulls stay empty.
	const unchanged = await server.pull({
		clientId,
		cookie: acknowledged.cookie,
		scanWindow,
	})
	expect(unchanged).toEqual({
		cookie: acknowledged.cookie,
		patch: { set: [], remove: [] },
		lastMutationId: undefined,
	})

	await server.close()
})

test("push acknowledgement is visible to the pull started by its poke", async () => {
	const { server } = createServer()
	const clientId = tag<ClientId>("poked-client")
	const mutationId = tag<MutationId>("poked-mutation")
	const scanWindow: ScanWindow<TestSchema> = [{ collection: "users" }]
	const initial = await server.pull({ clientId, scanWindow })
	const pokedPull =
		Promise.withResolvers<Awaited<ReturnType<RemoteApi<TestSchema>["pull"]>>>()
	const disconnect = await server.connect({
		clientId,
		poke: () => {
			void server
				.pull({ clientId, cookie: initial.cookie, scanWindow })
				.then(pokedPull.resolve, pokedPull.reject)
		},
	})

	await server.push({
		clientId,
		mutations: [
			{
				id: mutationId,
				ops: [
					{
						type: "set",
						collection: "users",
						value: { id: "user-1", name: "Ada" },
					},
				],
			},
		],
	})

	const result = await pokedPull.promise
	expect(result.lastMutationId).toBe(mutationId)
	expect(result.patch.set).toEqual([
		{ collection: "users", value: { id: "user-1", name: "Ada" } },
	])

	await disconnect()
	await server.close()
})

test("pull diffs filtered, paginated, and nested client views", async () => {
	const { server } = createServer()
	await seed(server)
	const messageTx = server.transact()
	messageTx.set("messages", {
		id: "thread-3",
		threadId: "thread-3",
		body: "Top thread message",
		createdAt: 3,
	})
	await server.commit(messageTx)

	const clientId = tag<ClientId>("view-client")
	const nestedPage: ScanWindow<TestSchema> = [
		{
			collection: "threads",
			select: ["id"],
			where: [["status", "=", "open"]],
			order: [["createdAt", "desc"]],
			limit: 1,
			with: {
				owner: { collection: "users", select: ["id"] },
				messages: {
					collection: "messages",
					select: ["id"],
					order: [["createdAt", "desc"]],
					limit: 1,
				},
			},
		},
	]

	// The initial page includes complete root and related records.
	const initial = await server.pull({ clientId, scanWindow: nestedPage })
	expect(patchSetKeys(initial.patch)).toEqual([
		"messages.thread-3",
		"threads.thread-3",
		"users.user-1",
	])
	expect(initial.patch.set).toContainEqual({
		collection: "threads",
		value: {
			id: "thread-3",
			ownerId: "user-1",
			title: "Bravo",
			status: "open",
			createdAt: 3,
		},
	})

	// A filtered row leaving the page removes it and promotes the next row.
	const closeTopTx = server.transact()
	await closeTopTx.update("threads", "thread-3", (thread) => ({
		...thread,
		status: "closed",
	}))
	await server.commit(closeTopTx)
	const promoted = await server.pull({
		clientId,
		cookie: initial.cookie,
		scanWindow: nestedPage,
	})
	expect(patchSetKeys(promoted.patch)).toEqual([
		"messages.message-2",
		"threads.thread-1",
		"users.user-1",
	])
	expect(patchRemoveKeys(promoted.patch)).toEqual([
		"messages.thread-3",
		"threads.thread-3",
	])

	// A row entering above the page displaces the previous page member.
	const openNewestTx = server.transact()
	await openNewestTx.update("threads", "thread-2", (thread) => ({
		...thread,
		status: "open",
		createdAt: 4,
	}))
	await server.commit(openNewestTx)
	const displaced = await server.pull({
		clientId,
		cookie: promoted.cookie,
		scanWindow: nestedPage,
	})
	expect(patchSetKeys(displaced.patch)).toEqual([
		"threads.thread-2",
		"users.user-1",
	])
	expect(patchRemoveKeys(displaced.patch)).toEqual([
		"messages.message-2",
		"threads.thread-1",
	])

	// Shrinking the scan window removes records that were included only by it.
	const rootOnlyPage: ScanWindow<TestSchema> = [
		{
			collection: "threads",
			where: [["status", "=", "open"]],
			order: [["createdAt", "desc"]],
			limit: 1,
		},
	]
	const shrunk = await server.pull({
		clientId,
		cookie: displaced.cookie,
		scanWindow: rootOnlyPage,
	})
	expect(patchSetKeys(shrunk.patch)).toEqual(["threads.thread-2"])
	expect(patchRemoveKeys(shrunk.patch)).toEqual(["users.user-1"])

	// An unchanged cookie and scan window avoid another snapshot patch.
	const unchanged = await server.pull({
		clientId,
		cookie: shrunk.cookie,
		scanWindow: rootOnlyPage,
	})
	expect(unchanged.patch).toEqual({ set: [], remove: [] })
	expect(unchanged.cookie).toBe(shrunk.cookie)

	await server.close()
})

test("pull rejects an encoded relation that targets the wrong collection", async () => {
	const { server } = createServer()
	const invalidScanWindow: ScanWindow<TestSchema> = [
		{
			collection: "threads",
			with: {
				owner: { collection: "messages" },
			},
		},
	]

	await expect(
		server.pull({
			clientId: tag<ClientId>("invalid-query-client"),
			scanWindow: invalidScanWindow,
		}),
	).rejects.toMatchObject({
		cause: expect.objectContaining({
			message:
				'Relation "threads.owner" targets collection "users", not "messages"',
		}),
	})

	await server.close()
})

test("application commits poke connected clients until they disconnect or close", async () => {
	const { server, storage } = createServer()
	const firstPoke = vi.fn()
	const secondPoke = vi.fn()
	const firstClientId = tag<ClientId>("connected-1")
	const secondClientId = tag<ClientId>("connected-2")
	const disconnectFirst = await server.connect({
		clientId: firstClientId,
		poke: firstPoke,
	})
	const disconnectSecond = await server.connect({
		clientId: secondClientId,
		poke: secondPoke,
	})

	// Empty pushes and application transactions do not advance or poke.
	await server.push({ clientId: firstClientId, mutations: [] })
	await server.commit(server.transact())
	expect(firstPoke).not.toHaveBeenCalled()
	expect(secondPoke).not.toHaveBeenCalled()

	// A successful application commit conservatively pokes every connection.
	const firstTx = server.transact()
	firstTx.set("users", { id: "user-1", name: "Ada" })
	await server.commit(firstTx)
	expect(firstPoke).toHaveBeenCalledTimes(1)
	expect(secondPoke).toHaveBeenCalledTimes(1)

	// Disconnect is idempotent and only detaches that client's callback.
	await disconnectFirst()
	await disconnectFirst()
	const secondTx = server.transact()
	secondTx.set("users", { id: "user-2", name: "Grace" })
	await server.commit(secondTx)
	expect(firstPoke).toHaveBeenCalledTimes(1)
	expect(secondPoke).toHaveBeenCalledTimes(2)

	// Close clears remaining sync registrations before closing storage.
	await server.close()
	expect(storage.closed).toBe(true)
	const afterCloseTx = server.transact()
	afterCloseTx.set("users", { id: "user-3", name: "Katherine" })
	await server.commit(afterCloseTx)
	expect(secondPoke).toHaveBeenCalledTimes(2)
	await disconnectSecond()
})

test("failed pushes do not acknowledge, advance, or poke", async () => {
	const { server, storage } = createServer()
	const clientId = tag<ClientId>("failing-client")
	const poke = vi.fn()
	await server.connect({ clientId, poke })
	const scanWindow: ScanWindow<TestSchema> = [{ collection: "users" }]
	const initial = await server.pull({ clientId, scanWindow })
	const storageCause = new Error("push storage unavailable")
	storage.failNextCommit(storageCause)

	await expect(
		server.push({
			clientId,
			mutations: [
				{
					id: tag<MutationId>("failed-mutation"),
					ops: [
						{
							type: "set",
							collection: "users",
							value: { id: "user-1", name: "Ada" },
						},
					],
				},
			],
		}),
	).rejects.toMatchObject({ cause: storageCause })
	expect(poke).not.toHaveBeenCalled()

	const afterFailure = await server.pull({
		clientId,
		cookie: initial.cookie,
		scanWindow,
	})
	expect(afterFailure).toEqual({
		cookie: initial.cookie,
		patch: { set: [], remove: [] },
		lastMutationId: undefined,
	})
	expect(await server.query({ collection: "users" })).toEqual([])

	await server.close()
})
