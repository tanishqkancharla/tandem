import { collection, defineSchema, tag } from "@tanishqkancharla/tandem-core"
import type {
	ClientId,
	MutationId,
	PokePayload,
	TimerApi,
} from "@tanishqkancharla/tandem-core"
import { assert, expect, test as baseTest } from "vitest"
import { TandemServer } from "../src/index.js"
import { TestTandemServerStorage } from "./TandemServerStorage.fixture.js"

type Message = { id: string; text: string; status: string }
type ChatSchema = { messages: Message }

const schema = defineSchema({
	messages: collection<Message>({ fields: ["id", "text", "status"] }),
})

type ChatServer = TandemServer<ChatSchema, {}>

const message = (id: string, overrides: Partial<Message> = {}): Message => ({
	id,
	text: "",
	status: "streaming",
	...overrides,
})

/** Ends the server's poke interval only when the test says so. */
class IntervalTimer implements TimerApi {
	private waiting: (() => void)[] = []

	waitForNextTick(): Promise<void> {
		return new Promise((resolve) => this.waiting.push(resolve))
	}

	async end() {
		for (const resolve of this.waiting.splice(0)) resolve()
		await new Promise((resolve) => setImmediate(resolve))
	}
}

async function appendText(
	tx: ReturnType<ChatServer["transact"]>,
	text: string,
) {
	const current = await tx.get("messages", "reply")
	if (current) tx.set("messages", { ...current, text: current.text + text })
}

const test = baseTest.extend<{
	interval: IntervalTimer
	server: ChatServer
	/** Connects a client, pulls everything, and records every poke it receives. */
	viewer: (name: string) => Promise<(PokePayload<ChatSchema> | undefined)[]>
	commit: (
		write: (tx: ReturnType<ChatServer["transact"]>) => unknown,
	) => Promise<void>
}>({
	interval: async ({}, use) => {
		await use(new IntervalTimer())
	},
	server: async ({ interval }, use) => {
		const server = new TandemServer({
			schema,
			relations: {},
			storage: new TestTandemServerStorage<ChatSchema>(),
			livePokeInterval: interval,
		})
		await use(server)
		await server.close()
	},
	viewer: async ({ server }, use) => {
		await use(async (name) => {
			const pokes: (PokePayload<ChatSchema> | undefined)[] = []
			const clientId = tag<ClientId>(name)
			await server.connect({
				clientId,
				poke: (payload) => {
					pokes.push(payload)
					return Promise.resolve()
				},
			})
			await server.pull({ clientId, scanWindow: [{ collection: "messages" }] })
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

test("a burst of appends reaches a viewer as one payload per interval, merged", async ({
	server,
	interval,
	viewer,
	commit,
}) => {
	await commit((tx) => tx.set("messages", message("reply", { text: "Hel" })))
	const pokes = await viewer("viewer")

	// The first append after a quiet interval goes out at once.
	await commit((tx) => appendText(tx, "l"))
	expect(pokes).toHaveLength(1)

	// Later appends wait for the interval to end, then go out together.
	await commit((tx) => appendText(tx, "o"))
	await commit((tx) => appendText(tx, "!"))
	expect(pokes).toHaveLength(1)
	await interval.end()
	const pulled = await server.pull({
		clientId: tag<ClientId>("reader"),
		scanWindow: [{ collection: "messages" }],
	})
	assert(!("error" in pulled))
	expect(pokes).toEqual([
		expect.anything(),
		{
			// The payload reflects the latest commit merged into it.
			revision: pulled.revision,
			append: [
				{
					collection: "messages",
					id: "reply",
					field: "text",
					offset: 4,
					text: "o!",
					after: pokes[0]!.revision,
				},
			],
		},
	])

	// An interval without commits ends the batching, so the next append goes out at once.
	await interval.end()
	await commit((tx) => appendText(tx, "?"))
	expect(pokes).toHaveLength(3)
})

test("an ordinary commit flushes buffered appends and pokes at once; appends a page shift could hide wait for the pull", async ({
	server,
	interval,
	viewer,
	commit,
}) => {
	await commit((tx) => tx.set("messages", message("reply", { text: "Hel" })))
	const pokes = await viewer("viewer")
	const pagePokes: (PokePayload<ChatSchema> | undefined)[] = []
	const page = [{ collection: "messages", limit: 10 }] as const
	await server.connect({
		clientId: tag<ClientId>("page"),
		poke: (payload) => {
			pagePokes.push(payload)
			return Promise.resolve()
		},
	})
	await server.pull({ clientId: tag<ClientId>("page"), scanWindow: [...page] })
	await commit((tx) => appendText(tx, "l"))
	await commit((tx) => appendText(tx, "o"))
	expect(pokes).toHaveLength(1)

	// A new record is not an append: the buffered text goes out, then a bare poke.
	await commit((tx) => tx.set("messages", message("note")))
	expect(pokes.slice(1)).toEqual([
		{
			revision: expect.any(Object),
			append: [expect.objectContaining({ id: "reply", offset: 4, text: "o" })],
		},
		undefined,
	])

	// Another record cannot move the reply out of an unlimited view, so its
	// text keeps streaming. Under a limit, the new record may have pushed the
	// reply off the page, so that viewer pulls first.
	await interval.end()
	await commit((tx) => appendText(tx, "!"))
	expect(pokes.at(-1)).toEqual({
		revision: expect.any(Object),
		append: [expect.objectContaining({ id: "reply", offset: 5, text: "!" })],
	})
	// The page viewer's last two pokes are the insert's and the append's.
	expect(pagePokes.slice(-2)).toEqual([undefined, undefined])

	// After its pull, the page viewer streams again.
	await server.pull({ clientId: tag<ClientId>("page"), scanWindow: [...page] })
	await interval.end()
	await commit((tx) => appendText(tx, "?"))
	expect(pagePokes.at(-1)).toEqual({
		revision: expect.any(Object),
		append: [expect.objectContaining({ id: "reply", offset: 6, text: "?" })],
	})

	// Appends buffered before a pull arrive with that pull instead.
	await commit((tx) => appendText(tx, "?"))
	const count = pokes.length
	await server.pull({
		clientId: tag<ClientId>("viewer"),
		scanWindow: [{ collection: "messages" }],
	})
	await interval.end()
	expect(pokes).toHaveLength(count)
})

test("the pusher gets its buffered appends and a bare poke at once, so it pulls its acknowledgement", async ({
	server,
	viewer,
	commit,
}) => {
	await commit((tx) => tx.set("messages", message("reply", { text: "Hel" })))
	const pokes = await viewer("pusher")
	await commit((tx) => appendText(tx, "l"))
	await commit((tx) => appendText(tx, "o"))
	expect(pokes).toHaveLength(1)

	await server.push({
		clientId: tag<ClientId>("pusher"),
		mutations: [
			{
				id: tag<MutationId>(1),
				ops: [{ type: "set", collection: "messages", value: message("mine") }],
			},
		],
	})

	expect(pokes.slice(1)).toEqual([
		{
			revision: expect.any(Object),
			append: [expect.objectContaining({ id: "reply", offset: 4, text: "o" })],
		},
		undefined,
	])
})
