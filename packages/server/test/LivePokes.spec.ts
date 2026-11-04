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
			// Each commit's payload goes out on its own; batching has its own tests.
			livePokeInterval: 0,
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

test("a commit bare-pokes each viewer whose queries read a collection it changed", async ({
	server,
	viewer,
	commit,
}) => {
	await commit((tx) => {
		tx.set("threads", { id: "thread-1", title: "Open" })
		tx.set("messages", message("m1"))
	})
	const threadOne = await viewer("thread-one", [
		{ collection: "messages", where: [["threadId", "=", "thread-1"]] },
	])
	const threadTitles = await viewer("titles", [{ collection: "threads" }])
	const withMessages = await viewer("with-messages", [
		{
			collection: "threads",
			where: [["id", "=", "thread-1"]],
			with: { messages: { collection: "messages" } },
		},
	])

	// A message in another thread pokes every viewer that reads messages,
	// including through an include, and no viewer that reads only threads.
	await commit((tx) =>
		tx.set("messages", message("m2", { threadId: "thread-2" })),
	)
	expect(threadOne).toEqual([undefined])
	expect(withMessages).toEqual([undefined])
	expect(threadTitles).toEqual([])

	// A partial update pokes too; the pull it starts sends the full record.
	const viewTx = server.transact()
	await viewTx.update("threads", "thread-1", { title: "Renamed" })
	await server.commit(viewTx)
	expect(threadTitles).toEqual([undefined])
	expect(withMessages).toEqual([undefined, undefined])
	expect(threadOne).toEqual([undefined])
})

test("an ordinary commit runs no viewer's query", async () => {
	const reads = { scans: 0 }
	class CountingStorage extends TestTandemServerStorage<ChatSchema> {
		override scan(
			args?: Parameters<TestTandemServerStorage<ChatSchema>["scan"]>[0],
		) {
			reads.scans += 1
			return super.scan(args)
		}
	}
	const scansPerCommit = async (viewers: number) => {
		const storage = new CountingStorage()
		const server = new TandemServer({ schema, relations, storage })
		const seedTx = server.transact()
		for (let index = 0; index < 500; index++)
			seedTx.set("messages", message(`m${index}`, { createdAt: index }))
		await server.commit(seedTx)
		for (let index = 0; index < viewers; index++) {
			const clientId = tag<ClientId>(`viewer-${index}`)
			await server.connect({ clientId, poke: () => Promise.resolve() })
			await server.pull({
				clientId,
				scanWindow: [
					{ collection: "messages", order: [["createdAt", "desc"]], limit: 50 },
				],
			})
		}
		reads.scans = 0
		const tx = server.transact()
		tx.set("messages", message("m250", { text: "Edited" }))
		await server.commit(tx)
		const scans = reads.scans
		await server.close()
		return scans
	}

	// The commit reads the record it replaces, however many clients watch.
	const alone = await scansPerCommit(0)
	expect(await scansPerCommit(10)).toBe(alone)
	expect(alone).toBeLessThanOrEqual(2)
})

test("only the pusher hears a push outside every viewer's collections", async ({
	server,
	viewer,
}) => {
	const pusherPokes = await viewer("pusher", [{ collection: "threads" }])
	const otherPokes = await viewer("other", [{ collection: "threads" }])

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

test("the server keeps the collections a pull read, even if the caller changes its array later", async ({
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

	// A transport refused the pull for threads, so the server never read it.
	scanWindow.push({ collection: "threads" })
	await commit((tx) => tx.set("threads", { id: "secret", title: "Secret" }))

	expect(pokes).toEqual([])
})

test("closing a client's last connection forgets its view, so a reconnect gets bare pokes until it pulls", async ({
	server,
	commit,
}) => {
	const clientId = tag<ClientId>("revoked")
	const pokes: (PokePayload<ChatSchema> | undefined)[] = []
	const poke = (payload?: PokePayload<ChatSchema>) => {
		pokes.push(payload)
		return Promise.resolve()
	}
	const disconnect = await server.connect({ clientId, poke })
	await server.pull({ clientId, scanWindow: [{ collection: "messages" }] })
	await disconnect()

	await server.connect({ clientId, poke })
	await commit((tx) => tx.set("messages", message("after-close")))

	expect(pokes).toEqual([undefined])
})

test("a pull that runs after the last connection closed records no view", async ({
	server,
	commit,
}) => {
	const clientId = tag<ClientId>("revoked")
	const scanWindow: ScanWindow<ChatSchema> = [{ collection: "messages" }]
	const pokes: (PokePayload<ChatSchema> | undefined)[] = []
	const poke = (payload?: PokePayload<ChatSchema>) => {
		pokes.push(payload)
		return Promise.resolve()
	}
	const disconnect = await server.connect({ clientId, poke })
	await server.pull({ clientId, scanWindow })

	// A pull queued behind a commit runs after the connection closes.
	const busyTx = server.transact()
	busyTx.set("messages", message("other", { threadId: "thread-2" }))
	const committing = server.commit(busyTx)
	const queuedPull = server.pull({ clientId, scanWindow })
	await disconnect()
	await Promise.all([committing, queuedPull])

	await server.connect({ clientId, poke })
	await commit((tx) => tx.set("messages", message("after-close")))
	expect(pokes).toEqual([undefined])
})
