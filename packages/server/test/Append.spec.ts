import { collection, defineSchema, tag } from "@tanishqkancharla/tandem-core"
import type {
	ClientId,
	PokePayload,
	ScanWindow,
} from "@tanishqkancharla/tandem-core"
import { assert, expect, test as baseTest } from "vitest"
import { TandemServer } from "../src/index.js"
import { TestTandemServerStorage } from "./TandemServerStorage.fixture.js"

type Message = {
	id: string
	threadId: string
	text: string
	status: string
	note?: string
}
type ChatSchema = { messages: Message }

const schema = defineSchema({
	messages: collection<Message>({
		fields: ["id", "threadId", "text", "status", "note"],
	}),
})

type ChatServer = TandemServer<ChatSchema, {}>

const message = (id: string, overrides: Partial<Message> = {}): Message => ({
	id,
	threadId: "thread-1",
	text: "",
	status: "streaming",
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
		write: (tx: ReturnType<ChatServer["transact"]>) => unknown,
	) => Promise<void>
}>({
	server: async ({}, use) => {
		const server = new TandemServer({
			schema,
			relations: {},
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
			await write(tx)
			await server.commit(tx)
		})
	},
})

test("append adds text to string fields when the transaction commits", async ({
	server,
	commit,
}) => {
	await commit((tx) => tx.set("messages", message("reply", { text: "Hel" })))

	// Queries and pulls see the whole record.
	await commit((tx) =>
		tx.append("messages", "reply", { text: "lo", note: "!" }),
	)
	expect(await server.query({ collection: "messages" })).toEqual([
		message("reply", { text: "Hello", note: "!" }),
	])
	const pulled = await server.pull({
		clientId: tag<ClientId>("reader"),
		scanWindow: [{ collection: "messages" }],
	})
	assert(!("error" in pulled))
	expect(pulled.patch.set).toEqual([
		{
			collection: "messages",
			value: message("reply", { text: "Hello", note: "!" }),
		},
	])

	// Transactions open at once each add their text to the value at commit.
	const firstTx = server.transact().append("messages", "reply", { text: "," })
	const secondTx = server
		.transact()
		.append("messages", "reply", { text: " you" })
	await Promise.all([server.commit(firstTx), server.commit(secondTx)])
	expect((await server.query({ collection: "messages" }))[0]?.text).toBe(
		"Hello, you",
	)

	// A missing record stays missing.
	await commit((tx) => tx.append("messages", "missing", { text: "Hi" }))
	expect(await server.query({ collection: "messages" })).toHaveLength(1)
})

test("later writes in a transaction replace text it appended before them", async ({
	server,
	commit,
}) => {
	await commit((tx) => tx.set("messages", message("reply", { text: "Hel" })))

	await commit(async (tx) => {
		tx.append("messages", "reply", { text: "lo", note: "draft" })
		await tx.update("messages", "reply", { note: "final" })
	})
	expect((await server.query({ collection: "messages" }))[0]).toEqual(
		message("reply", { text: "Hello", note: "final" }),
	)

	await commit((tx) => {
		tx.append("messages", "reply", { text: " there" })
		tx.set("messages", message("reply", { text: "Reset" }))
		tx.append("messages", "reply", { text: "!" })
	})
	expect((await server.query({ collection: "messages" }))[0]?.text).toBe(
		"Reset!",
	)

	await commit((tx) => {
		tx.append("messages", "reply", { text: " again" })
		tx.remove("messages", "reply")
	})
	expect(await server.query({ collection: "messages" })).toEqual([])
})

test("appending to a field whose stored value is not a string fails the commit", async ({
	server,
	commit,
}) => {
	await commit((tx) =>
		tx.set("messages", message("reply", { text: 42 as unknown as string })),
	)

	const tx = server.transact().append("messages", "reply", { text: "!" })
	await expect(server.commit(tx)).rejects.toThrow("append failed")
	expect((await server.query({ collection: "messages" }))[0]?.text).toBe(42)
})

test("a viewer that has the record receives only the appended text", async ({
	server,
	viewer,
	commit,
}) => {
	await commit((tx) => tx.set("messages", message("reply", { text: "Hel" })))
	const pokes = await viewer("viewer", [{ collection: "messages" }])
	const pulled = await server.pull({
		clientId: tag<ClientId>("viewer"),
		scanWindow: [{ collection: "messages" }],
	})
	assert(!("error" in pulled))

	// The first append extends the value the viewer pulled.
	await commit((tx) => tx.append("messages", "reply", { text: "lo" }))
	expect(pokes).toEqual([
		{
			revision: expect.any(Object),
			append: [
				{
					collection: "messages",
					id: "reply",
					field: "text",
					offset: 3,
					text: "lo",
					after: pulled.revision,
				},
			],
		},
	])

	// The next extends the value that poke carried.
	await commit((tx) => tx.append("messages", "reply", { text: "!" }))
	expect(pokes.at(-1)?.append).toEqual([
		expect.objectContaining({
			offset: 5,
			text: "!",
			after: pokes[0]!.revision,
		}),
	])
})

test("an append never names a record the viewer cannot see or has not seen", async ({
	viewer,
	commit,
}) => {
	await commit((tx) => {
		tx.set("messages", message("hidden", { threadId: "thread-2", text: "Se" }))
		tx.set("messages", message("draft", { text: "Hell" }))
	})
	const threadPokes = await viewer("thread", [
		{ collection: "messages", where: [["threadId", "=", "thread-1"]] },
	])
	const donePokes = await viewer("done", [
		{ collection: "messages", where: [["text", "=", "Hello"]] },
	])

	// A record outside the view reaches nobody.
	await commit((tx) => tx.append("messages", "hidden", { text: "cret" }))
	expect(threadPokes).toEqual([])
	expect(donePokes).toEqual([])

	// A record an append moves into a view arrives whole, since the viewer
	// has never seen it, and leaves as a removal.
	await commit((tx) => tx.append("messages", "draft", { text: "o" }))
	expect(donePokes).toEqual([
		{
			revision: expect.any(Object),
			set: [
				{ collection: "messages", value: message("draft", { text: "Hello" }) },
			],
		},
	])
	await commit((tx) => tx.append("messages", "draft", { text: "!" }))
	expect(donePokes.at(-1)).toEqual({
		revision: expect.any(Object),
		remove: [{ collection: "messages", id: "draft" }],
	})
	expect(threadPokes.map((poke) => poke?.append?.[0]?.text)).toEqual(["o", "!"])
})
