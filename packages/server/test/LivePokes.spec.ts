import {
	collection,
	defineRelations,
	defineSchema,
	tag,
} from "@tanishqkancharla/tandem-core"
import type {
	ClientId,
	MutationId,
	PokePayload,
	ScanWindow,
} from "@tanishqkancharla/tandem-core"
import { assert, expect, test as baseTest } from "vitest"
import { TandemServer } from "../src/index.js"
import { TestTandemServerStorage } from "./TandemServerStorage.fixture.js"

type Thread = { id: string; title: string }
type Message = {
	id: string
	threadId: string
	text: string
	createdAt: number
}
type ChatSchema = { threads: Thread; messages: Message }

const schema = defineSchema({
	threads: collection<Thread>({ fields: ["id", "title"] }),
	messages: collection<Message>({
		fields: ["id", "threadId", "text", "createdAt"],
	}),
})

const relations = defineRelations(schema, ({ many }) => ({
	threads: { messages: many("messages", { from: "id", to: "threadId" }) },
}))

type ChatServer = TandemServer<ChatSchema, typeof relations>

const message = (id: string, overrides: Partial<Message> = {}): Message => ({
	id,
	threadId: "thread-1",
	text: `Message ${id}`,
	createdAt: 1,
	...overrides,
})

const test = baseTest.extend<{
	server: ChatServer
	/** Connects a client, pulls its window, and records every poke it receives. */
	viewer: (
		name: string,
		scanWindow: ScanWindow<ChatSchema>,
	) => Promise<(PokePayload<ChatSchema> | undefined)[]>
	commit: (
		write: (tx: ReturnType<ChatServer["transact"]>) => void,
	) => Promise<void>
}>({
	server: async ({}, use) => {
		const server = new TandemServer({
			schema,
			relations,
			storage: new TestTandemServerStorage<ChatSchema>(),
		})
		await use(server)
		await server.close()
	},
	viewer: async ({ server }, use) => {
		await use(async (name, scanWindow) => {
			const pokes: (PokePayload<ChatSchema> | undefined)[] = []
			const clientId = tag<ClientId>(name)
			await server.connect({
				clientId,
				poke: (payload) => {
					pokes.push(payload)
					return Promise.resolve()
				},
			})
			await server.pull({ clientId, scanWindow })
			return pokes
		})
	},
	commit: async ({ server }, use) => {
		await use(async (write) => {
			const tx = server.transact()
			write(tx)
			await server.commit(tx)
		})
	},
})

test("a commit pokes each viewer with the changed records in its view, at the revision a later pull reports", async ({
	server,
	viewer,
	commit,
}) => {
	const threadOne = await viewer("thread-one", [
		{ collection: "messages", where: [["threadId", "=", "thread-1"]] },
	])
	const threadTwo = await viewer("thread-two", [
		{ collection: "messages", where: [["threadId", "=", "thread-2"]] },
	])

	await commit((tx) => {
		tx.set("messages", message("m1"))
		tx.set("messages", message("m2", { threadId: "thread-2" }))
	})

	// Each viewer receives only its own thread's message.
	expect(threadOne).toEqual([
		{
			revision: expect.any(Object),
			set: [{ collection: "messages", value: message("m1") }],
		},
	])
	expect(threadTwo).toEqual([
		{
			revision: threadOne[0]!.revision,
			set: [
				{
					collection: "messages",
					value: message("m2", { threadId: "thread-2" }),
				},
			],
		},
	])

	// A pull after the commit reports that commit's revision; the next commit is newer.
	const pulled = await server.pull({
		clientId: tag<ClientId>("thread-one"),
		scanWindow: [{ collection: "messages" }],
	})
	assert(!("error" in pulled))
	expect(pulled.revision).toEqual(threadOne[0]!.revision)
	await commit((tx) => tx.set("messages", message("m1", { text: "Edited" })))
	expect(threadOne.at(-1)?.revision).toEqual({
		server: pulled.revision!.server,
		commit: pulled.revision!.commit + 1,
	})
})

test("pokes never name records outside the view, and only the pusher hears an unrelated push", async ({
	server,
	viewer,
	commit,
}) => {
	const pusherPokes = await viewer("pusher", [
		{ collection: "messages", where: [["threadId", "=", "thread-1"]] },
	])
	const otherPokes = await viewer("other", [
		{ collection: "messages", where: [["threadId", "=", "thread-1"]] },
	])

	// A server write outside every view pokes nobody.
	await commit((tx) => tx.set("messages", message("hidden", { threadId: "x" })))
	await commit((tx) => tx.remove("messages", "hidden"))
	expect(pusherPokes).toEqual([])
	expect(otherPokes).toEqual([])

	// The pusher still gets a bare poke, so its pull acknowledges the mutation.
	await server.push({
		clientId: tag<ClientId>("pusher"),
		mutations: [
			{
				id: tag<MutationId>(1),
				ops: [
					{
						type: "set",
						collection: "messages",
						value: message("elsewhere", { threadId: "thread-2" }),
					},
				],
			},
		],
	})
	expect(pusherPokes).toEqual([undefined])
	expect(otherPokes).toEqual([])
})

test("deletes and records leaving the view arrive as removals of records the viewer knows", async ({
	viewer,
	commit,
}) => {
	await commit((tx) => {
		tx.set("messages", message("pulled"))
		tx.set("messages", message("moved"))
	})
	const pokes = await viewer("viewer", [
		{ collection: "messages", where: [["threadId", "=", "thread-1"]] },
	])

	// A record created after the pull is known once it was sent live.
	await commit((tx) => tx.set("messages", message("live")))
	await commit((tx) => {
		tx.remove("messages", "pulled")
		tx.remove("messages", "live")
		tx.set("messages", message("moved", { threadId: "thread-2" }))
	})

	expect(pokes.at(-1)).toEqual({
		revision: expect.any(Object),
		remove: [
			{ collection: "messages", id: "live" },
			{ collection: "messages", id: "pulled" },
			{ collection: "messages", id: "moved" },
		],
	})
})

test("partial updates poke with the full record", async ({
	server,
	viewer,
	commit,
}) => {
	await commit((tx) => tx.set("messages", message("m1")))
	const pokes = await viewer("viewer", [{ collection: "messages" }])

	const tx = server.transact()
	await tx.update("messages", "m1", { text: "Updated" })
	await server.commit(tx)

	expect(pokes).toEqual([
		{
			revision: expect.any(Object),
			set: [
				{ collection: "messages", value: message("m1", { text: "Updated" }) },
			],
		},
	])
})

test("relation includes and limits decide membership the way a pull does", async ({
	viewer,
	commit,
}) => {
	await commit((tx) => {
		tx.set("threads", { id: "thread-1", title: "Open" })
		tx.set("messages", message("old", { createdAt: 1 }))
	})
	const includePokes = await viewer("include", [
		{
			collection: "threads",
			where: [["id", "=", "thread-1"]],
			with: { messages: { collection: "messages" } },
		},
	])
	const latestPokes = await viewer("latest", [
		{ collection: "messages", order: [["createdAt", "desc"]], limit: 1 },
	])

	// A message included through its thread reaches the include viewer. It is
	// also the newest message, so it displaces the limit viewer's record.
	await commit((tx) => tx.set("messages", message("new", { createdAt: 2 })))
	expect(includePokes).toEqual([
		{
			revision: expect.any(Object),
			set: [
				{ collection: "messages", value: message("new", { createdAt: 2 }) },
			],
		},
	])
	expect(latestPokes).toEqual([
		{
			revision: expect.any(Object),
			set: [
				{ collection: "messages", value: message("new", { createdAt: 2 }) },
			],
		},
	])

	// Messages of other threads and older messages stay out of both views.
	await commit((tx) => {
		tx.set("messages", message("other", { threadId: "thread-2", createdAt: 0 }))
	})
	expect(includePokes).toHaveLength(1)
	expect(latestPokes).toHaveLength(1)
})

test("a new server instance numbers revisions under a new identity", async () => {
	const storage = new TestTandemServerStorage<ChatSchema>()
	const clientId = tag<ClientId>("client")
	const scanWindow: ScanWindow<ChatSchema> = [{ collection: "messages" }]
	const revisions = []
	for (const _restart of [1, 2]) {
		const server = new TandemServer({ schema, relations, storage })
		const pulled = await server.pull({ clientId, scanWindow })
		assert(!("error" in pulled))
		revisions.push(pulled.revision)
	}

	expect(revisions[0]!.commit).toBe(0)
	expect(revisions[1]!.commit).toBe(0)
	expect(revisions[0]!.server).not.toBe(revisions[1]!.server)
})

test("a commit that shifts an offset window pokes the viewer, without naming unseen records", async ({
	viewer,
	commit,
}) => {
	await commit((tx) => {
		tx.set("messages", message("m1", { createdAt: 1 }))
		tx.set("messages", message("m2", { createdAt: 2 }))
		tx.set("messages", message("m3", { createdAt: 3 }))
	})
	const pokes = await viewer("paged", [
		{
			collection: "messages",
			order: [["createdAt", "asc"]],
			offset: 1,
			limit: 1,
		},
	])

	// Removing a record before the page moves m3 into view.
	await commit((tx) => tx.remove("messages", "m1"))
	expect(pokes).toEqual([undefined])

	// So does inserting one before it.
	await commit((tx) => tx.set("messages", message("m0", { createdAt: 0 })))
	expect(pokes).toEqual([undefined, undefined])
})

test("the server keeps the window a pull read, even if the caller changes its array later", async ({
	server,
	commit,
}) => {
	const clientId = tag<ClientId>("in-process")
	const pokes: (PokePayload<ChatSchema> | undefined)[] = []
	await server.connect({
		clientId,
		poke: (payload) => {
			pokes.push(payload)
			return Promise.resolve()
		},
	})
	const scanWindow: ScanWindow<ChatSchema> = [
		{ collection: "messages", where: [["threadId", "=", "thread-1"]] },
	]
	await server.pull({ clientId, scanWindow })

	// A transport refused the pull for thread-2, so the server never read it.
	scanWindow.push({
		collection: "messages",
		where: [["threadId", "=", "thread-2"]],
	})
	await commit((tx) =>
		tx.set("messages", message("secret", { threadId: "thread-2" })),
	)

	expect(pokes).toEqual([])
})
