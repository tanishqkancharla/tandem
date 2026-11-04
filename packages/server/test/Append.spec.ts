import {
	codec,
	collection,
	defineMutator,
	defineSchema,
	partialObject,
	string,
	tag,
} from "@tanishqkancharla/tandem-core"
import type {
	ClientId,
	PokePayload,
	ScanWindow,
} from "@tanishqkancharla/tandem-core"
import { InMemoryTupleStorage } from "tuple-database"
import type { ScanStorageArgs, WriteOps } from "tuple-database"
import { assert, expect, test as baseTest, vi } from "vitest"
import { TandemServer, type TandemTuple } from "../src/index.js"
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

const appendMessage = defineMutator(schema, {
	args: (input: unknown) =>
		input as { id: string; text: string; follow?: boolean },
	run: async (tx, { id, text }) => {
		const current = await tx.get("messages", id)
		if (current) tx.set("messages", { ...current, text: current.text + text })
	},
})

type ChatServer = TandemServer<ChatSchema, {}>

const message = (id: string, overrides: Partial<Message> = {}): Message => ({
	id,
	threadId: "thread-1",
	text: "",
	status: "streaming",
	...overrides,
})

async function appendFields(
	tx: ReturnType<ChatServer["transact"]>,
	id: string,
	fields: { text?: string; note?: string },
) {
	const current = await tx.get("messages", id)
	if (!current) return
	tx.set("messages", {
		...current,
		...(fields.text ? { text: current.text + fields.text } : {}),
		...(fields.note ? { note: (current.note ?? "") + fields.note } : {}),
	})
}

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
			await write(tx)
			await server.commit(tx)
		})
	},
})

test("get/set appends multiple fields and leaves missing records absent", async ({
	server,
	commit,
}) => {
	await commit((tx) => tx.set("messages", message("reply", { text: "Hel" })))
	await commit((tx) => appendFields(tx, "reply", { text: "lo", note: "!" }))
	expect(await server.query({ collection: "messages" })).toEqual([
		message("reply", { text: "Hello", note: "!" }),
	])
	await commit((tx) => appendFields(tx, "missing", { text: "Hi" }))
	expect(await server.query({ collection: "messages" })).toHaveLength(1)
})

test("only lossless string growth produces a compact poke", async ({
	server,
	viewer,
	commit,
}) => {
	await commit((tx) =>
		tx.set("messages", message("reply", { text: "A", note: "x" })),
	)
	const pokes = await viewer("classification", [{ collection: "messages" }])
	await commit((tx) =>
		tx.set("messages", message("reply", { text: "AB", note: "xy" })),
	)
	expect(pokes.at(-1)?.append).toEqual([
		expect.objectContaining({ field: "text", offset: 1, text: "B" }),
		expect.objectContaining({ field: "note", offset: 1, text: "y" }),
	])

	// Any other change pokes bare; the pull it starts sends the record.
	for (const next of [
		message("reply", { text: "ABC", note: "xy", status: "done" }),
		message("reply", { text: "Z", status: "done" }),
		message("reply", { text: "ZZ", status: 0 as unknown as string }),
		message("reply", { text: "ZZZ", status: false as unknown as string }),
	]) {
		await commit((tx) => tx.set("messages", next))
		expect(pokes.at(-1)).toBeUndefined()
		await server.pull({
			clientId: tag<ClientId>("classification"),
			scanWindow: [{ collection: "messages" }],
		})
	}
})

test("growth a codec cannot carry on its own pokes bare", async () => {
	type Coded = { id: string; text: string; meta?: Map<string, string> }
	const codedSchema = defineSchema({
		messages: collection<Coded>({
			fields: ["id", "text", "meta"],
			codec: partialObject({
				id: string,
				text: codec<string, string>(
					"at-least-two-characters",
					(value) => {
						if (typeof value !== "string" || value.length < 2)
							throw new Error("short text")
						return value
					},
					(value) => value as string,
				),
				meta: codec<Map<string, string>, [string, string][]>(
					"map-entries",
					(value) => [...(value as Map<string, string>).entries()],
					(value) => new Map(value as [string, string][]),
				),
			}),
		}),
	})
	const server = new TandemServer({
		schema: codedSchema,
		relations: {},
		storage: new TestTandemServerStorage<{ messages: Coded }>(),
		livePokeInterval: 0,
	})
	const clientId = tag<ClientId>("codec-viewer")
	const scanWindow: ScanWindow<{ messages: Coded }> = [
		{ collection: "messages" },
	]
	const pokes: (PokePayload<{ messages: Coded }> | undefined)[] = []
	await server.connect({
		clientId,
		poke: (payload) => {
			pokes.push(payload)
			return Promise.resolve()
		},
	})
	const initial = server.transact()
	initial.set("messages", {
		id: "reply",
		text: "Hello",
		meta: new Map([["a", "old"]]),
	})
	await server.commit(initial)
	await server.pull({ clientId, scanWindow })
	pokes.length = 0

	// The suffix alone fails the codec, so the pull sends the whole record.
	const update = server.transact()
	await update.update("messages", "reply", { text: "Hello!" })
	await server.commit(update)
	expect(pokes).toEqual([undefined])

	// A changed Map beside the growth is not an append either.
	const pulled = await server.pull({ clientId, scanWindow })
	const mapTx = server.transact()
	mapTx.set("messages", {
		id: "reply",
		text: "Hello!!",
		meta: new Map([["a", "new"]]),
	})
	await server.commit(mapTx)
	expect(pokes).toEqual([undefined, undefined])
	assert(!("error" in pulled))
	const next = await server.pull({
		clientId,
		scanWindow,
		cookie: pulled.cookie,
	})
	assert(!("error" in next))
	expect(next.patch.set?.[0]?.value.meta?.get("a")).toBe("new")
	await server.close()
})

test("named direct appends retain deltas, concurrent text, and nested afterCommit calls", async () => {
	let server!: TandemServer<
		ChatSchema,
		{},
		{ appendMessage: typeof appendMessage }
	>
	server = new TandemServer({
		schema,
		relations: {},
		storage: new TestTandemServerStorage<ChatSchema>(),
		livePokeInterval: 0,
		mutators: { appendMessage },
		hooks: () => ({
			appendMessage: {
				afterCommit: ({ id, follow }) => {
					if (follow) return server.mutate.appendMessage({ id, text: "!" })
				},
			},
		}),
	})
	const tx = server.transact()
	tx.set("messages", message("reply", { text: "Start" }))
	await server.commit(tx)
	const pokes: (PokePayload<ChatSchema> | undefined)[] = []
	const clientId = tag<ClientId>("named-reader")
	await server.connect({
		clientId,
		poke: (payload) => {
			pokes.push(payload)
			return Promise.resolve()
		},
	})
	await server.pull({ clientId, scanWindow: [{ collection: "messages" }] })
	await Promise.all([
		server.mutate.appendMessage({ id: "reply", text: " A" }),
		server.mutate.appendMessage({ id: "reply", text: " B" }),
	])
	await server.mutate.appendMessage({
		id: "reply",
		text: " C",
		follow: true,
	})
	await vi.waitFor(async () =>
		expect((await server.query({ collection: "messages" }))[0]?.text).toBe(
			"Start A B C!",
		),
	)
	expect(
		pokes.some((payload) =>
			payload?.append?.some(({ text }) => text.includes(" A")),
		),
	).toBe(true)
	await server.close()
})

test("a failing afterCommit is logged after the named append commits", async () => {
	const server = new TandemServer({
		schema,
		relations: {},
		storage: new TestTandemServerStorage<ChatSchema>(),
		mutators: { appendMessage },
		hooks: () => ({
			appendMessage: {
				afterCommit: () => {
					throw new Error("Notification unavailable")
				},
			},
		}),
	})
	const tx = server.transact()
	tx.set("messages", message("reply"))
	await server.commit(tx)
	const logged = vi.spyOn(console, "error").mockImplementation(() => {})
	const append = server.mutate.appendMessage
	await append({ id: "reply", text: "Saved" })
	expect((await server.query({ collection: "messages" }))[0]?.text).toBe(
		"Saved",
	)
	expect(logged).toHaveBeenCalledOnce()
	logged.mockRestore()
	await server.close()
})

test("final transaction writes determine whether a poke is an append", async ({
	server,
	viewer,
	commit,
}) => {
	await commit((tx) => tx.set("messages", message("reply", { text: "Hel" })))
	const pokes = await viewer("final-writes", [{ collection: "messages" }])
	await commit(async (tx) => {
		await appendFields(tx, "reply", { text: "lo" })
		tx.set("messages", message("reply", { text: "Reset" }))
		await appendFields(tx, "reply", { text: "!" })
	})
	expect((await server.query({ collection: "messages" }))[0]?.text).toBe(
		"Reset!",
	)
	expect(pokes).toEqual([undefined])
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
	await commit((tx) => appendFields(tx, "reply", { text: "lo" }))
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
	await commit((tx) => appendFields(tx, "reply", { text: "!" }))
	expect(pokes.at(-1)?.append).toEqual([
		expect.objectContaining({
			offset: 5,
			text: "!",
			after: pokes[0]!.revision,
		}),
	])
})

test("an append the viewer lacks, or one that can change its queries, pokes bare", async ({
	server,
	viewer,
	commit,
}) => {
	await commit((tx) => {
		tx.set("messages", message("hidden", { threadId: "thread-2", text: "Se" }))
		tx.set("messages", message("draft", { text: "Hell" }))
	})
	const thread: ScanWindow<ChatSchema> = [
		{ collection: "messages", where: [["threadId", "=", "thread-1"]] },
	]
	const done: ScanWindow<ChatSchema> = [
		{ collection: "messages", where: [["text", "=", "Hello"]] },
	]
	const latest: ScanWindow<ChatSchema> = [
		{ collection: "messages", order: [["text", "desc"]], limit: 1 },
	]
	const threadPokes = await viewer("thread", thread)
	const donePokes = await viewer("done", done)
	const latestPokes = await viewer("latest", latest)

	// A record outside the thread view is not one the viewer has, so its text stays out.
	await commit((tx) => appendFields(tx, "hidden", { text: "cret" }))
	expect(threadPokes).toEqual([undefined])

	// Text that a filter or an ordering reads can change which records a
	// query selects, so those viewers pull instead of seeing the text.
	await server.pull({ clientId: tag<ClientId>("thread"), scanWindow: thread })
	await server.pull({ clientId: tag<ClientId>("done"), scanWindow: done })
	await server.pull({ clientId: tag<ClientId>("latest"), scanWindow: latest })
	await commit((tx) => appendFields(tx, "draft", { text: "o" }))
	expect(donePokes).toEqual([undefined, undefined])
	expect(latestPokes).toEqual([undefined, undefined])

	// The thread viewer has the draft and filters on threadId only.
	expect(threadPokes.at(-1)?.append).toEqual([
		expect.objectContaining({ id: "draft", offset: 4, text: "o" }),
	])
})

test("an append to a record changed behind the server's back pokes bare", async () => {
	const storage = new TestTandemServerStorage<ChatSchema>()
	const direct = new TandemServer({
		schema,
		relations: {},
		storage,
		livePokeInterval: 0,
	})
	const clientId = tag<ClientId>("viewer")
	const pokes: (PokePayload<ChatSchema> | undefined)[] = []
	await direct.connect({
		clientId,
		poke: (payload) => {
			pokes.push(payload)
			return Promise.resolve()
		},
	})
	const setTx = direct.transact()
	setTx.set("messages", message("reply", { text: "Hel" }))
	await direct.commit(setTx)
	await direct.pull({ clientId, scanWindow: [{ collection: "messages" }] })
	pokes.length = 0

	// Another writer changes the record without a notification.
	await storage.commit({
		set: [
			{
				key: ["record", "messages", "reply"],
				value: message("reply", { text: "Hel", threadId: "thread-2" }),
			},
		],
	})
	const appendTx = direct.transact()
	await appendFields(appendTx, "reply", { text: "lo" })
	await direct.commit(appendTx)
	expect(pokes).toEqual([undefined])
	await direct.close()
})

/** Storage two server processes share, which tells each about every commit. */
class SharedStorage {
	private readonly memory = new InMemoryTupleStorage()
	private readonly listeners = new Set<() => void>()

	scan(args?: ScanStorageArgs) {
		return Promise.resolve(this.memory.scan(args) as TandemTuple<ChatSchema>[])
	}

	commit(writes: WriteOps<TandemTuple<ChatSchema>>) {
		this.memory.commit(writes)
		for (const listener of this.listeners) listener()
		return Promise.resolve()
	}

	subscribe(onChange: () => void) {
		this.listeners.add(onChange)
		return () => this.listeners.delete(onChange)
	}

	close() {
		return Promise.resolve()
	}
}

test("after another process writes storage, appends wait for a pull that read it", async () => {
	const storage = new SharedStorage()
	const local = new TandemServer({
		schema,
		relations: {},
		storage,
		livePokeInterval: 0,
	})
	const other = new TandemServer({ schema, relations: {}, storage })
	const clientId = tag<ClientId>("viewer")
	const pokes: (PokePayload<ChatSchema> | undefined)[] = []
	await local.connect({
		clientId,
		poke: (payload) => {
			pokes.push(payload)
			return Promise.resolve()
		},
	})
	const setTx = local.transact()
	setTx.set("messages", message("reply", { text: "ab" }))
	await local.commit(setTx)
	const pulled = await local.pull({
		clientId,
		scanWindow: [{ collection: "messages" }],
	})
	assert(!("error" in pulled))
	pokes.length = 0

	// The server's own commit sends only its payload, not an extra bare poke.
	const appendTx = local.transact()
	await appendFields(appendTx, "reply", { text: "c" })
	await local.commit(appendTx)
	expect(pokes).toEqual([
		expect.objectContaining({
			append: [expect.objectContaining({ after: pulled.revision })],
		}),
	])

	// Another process rewrites the text. Its notification pokes the viewer,
	// and appends poke bare until the viewer pulls what the process wrote.
	const rewriteTx = other.transact()
	rewriteTx.set("messages", message("reply", { text: "xy" }))
	await other.commit(rewriteTx)
	const secondAppendTx = local.transact()
	await appendFields(secondAppendTx, "reply", { text: "!" })
	await local.commit(secondAppendTx)
	expect(pokes.slice(1)).toEqual([undefined, undefined])

	// After that pull, the next append extends the value it read.
	const repulled = await local.pull({
		clientId,
		cookie: pulled.cookie,
		scanWindow: [{ collection: "messages" }],
	})
	assert(!("error" in repulled))
	const thirdAppendTx = local.transact()
	await appendFields(thirdAppendTx, "reply", { text: "?" })
	await local.commit(thirdAppendTx)
	const [op] = pokes.at(-1)!.append!
	expect(op).toMatchObject({ offset: 3, text: "?" })
	expect(op!.after.commit).toBeGreaterThan(pokes[0]!.revision.commit)
	await Promise.all([local.close(), other.close()])
})
