import {
	collection,
	defineMutator,
	defineSchema,
	tag,
	type ClientId,
	type MutationId,
} from "@tanishqkancharla/tandem-core"
import { InMemoryTupleStorage } from "tuple-database"
import type { ScanStorageArgs, WriteOps } from "tuple-database"
import { expect, expectTypeOf, test } from "vitest"
import {
	TandemServer,
	type TandemServerStorageApi,
	type TandemTuple,
} from "../src/index.js"
import { TestTandemServerStorage } from "./TandemServerStorage.fixture.js"

type Message = {
	id: string
	threadId: string
	createdAt: number
	text: string
}
type ChatSchema = { messages: Message }

const indexed = defineSchema({
	messages: collection<Message>({
		fields: ["id", "threadId", "createdAt", "text"],
		indexes: { byThread: ["threadId", "createdAt"] },
	}),
})

const appendText = defineMutator(indexed, {
	args: (input: unknown) => input as { id: string; text: string },
	run: async (tx, { id, text }) => {
		const current = await tx.get("messages", id)
		if (current) tx.set("messages", { ...current, text: current.text + text })
	},
})

const message = (id: string, overrides: Partial<Message> = {}): Message => ({
	id,
	threadId: "t1",
	createdAt: 1,
	text: "",
	...overrides,
})

/** The entries storage should hold for these records, in key order. */
function entriesFor(records: readonly Message[], index = "byThread") {
	return records
		.map((record) => ({
			key: [
				"index",
				"messages",
				index,
				record.threadId,
				record.createdAt,
				record.id,
			],
			value: null,
		}))
		.sort((left, right) =>
			JSON.stringify(left.key) < JSON.stringify(right.key) ? -1 : 1,
		)
}

async function storedEntries(storage: TandemServerStorageApi<ChatSchema>) {
	return storage.scan({ gte: ["index"], lte: ["index", true] })
}

/** Storage that tells subscribers when another process writes it. */
class NotifyingStorage implements TandemServerStorageApi<ChatSchema> {
	readonly memory = new InMemoryTupleStorage()
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

test("index entries follow every server write path in the record's commit", async () => {
	const storage = new TestTandemServerStorage<ChatSchema>()
	const server = new TandemServer({
		schema: indexed,
		relations: {},
		storage,
		mutators: { appendText },
	})
	const clientId = tag<ClientId>("writer")

	// A server transaction, a partial update, and a remove.
	const tx = server.transact()
	tx.set("messages", message("m1", { createdAt: 3 }))
	tx.set("messages", message("m2", { threadId: "t2" }))
	tx.set("messages", message("m3", { createdAt: 2 }))
	await server.commit(tx)
	const updateTx = server.transact()
	await updateTx.update("messages", "m1", { createdAt: 5 })
	updateTx.remove("messages", "m3")
	await server.commit(updateTx)

	// A client push and a named mutation. Text is not indexed, so its entry stays.
	await server.push(
		{
			clientId,
			mutations: [
				{
					id: tag<MutationId>(1),
					ops: [
						{ type: "set", collection: "messages", value: message("m4") },
						{ type: "remove", collection: "messages", id: "m2" },
					],
				},
				{
					id: tag<MutationId>(2),
					ops: [],
					mutator: { name: "appendText", args: { id: "m4", text: "hi" } },
				},
			],
		},
		{ allowOps: true },
	)

	const records = await server.query({ collection: "messages" })
	expect(records).toEqual([
		message("m1", { createdAt: 5 }),
		message("m4", { text: "hi" }),
	])
	expect(await storedEntries(storage)).toEqual(entriesFor(records))
	expect(await storage.scan({ gte: ["indexes"], lte: ["indexes"] })).toEqual([
		{
			key: ["indexes"],
			value: {
				definitions: '[["messages","byThread",["threadId","createdAt"]]]',
			},
		},
	])
	await server.close()
})

test("a server rebuilds entries before its first read when the definitions changed", async () => {
	const storage = new TestTandemServerStorage<ChatSchema>()
	const plain = new TandemServer({
		schema: defineSchema({
			messages: collection<Message>({
				fields: ["id", "threadId", "createdAt", "text"],
			}),
		}),
		relations: {},
		storage,
	})
	const tx = plain.transact()
	tx.set("messages", message("m1"))
	tx.set("messages", message("m2", { createdAt: 2 }))
	await plain.commit(tx)
	await plain.close()
	expect(await storedEntries(storage)).toEqual([])

	// Adding an index builds its entries before the first query reads them.
	const server = new TandemServer({ schema: indexed, relations: {}, storage })
	const records = await server.query({ collection: "messages" })
	expect(await storedEntries(storage)).toEqual(entriesFor(records))
	await server.close()

	// Renaming it replaces the old entries.
	const renamed = new TandemServer({
		schema: defineSchema({
			messages: collection<Message>({
				fields: ["id", "threadId", "createdAt", "text"],
				indexes: { threadOrder: ["threadId", "createdAt"] },
			}),
		}),
		relations: {},
		storage,
	})
	await renamed.pull({ clientId: tag<ClientId>("reader"), scanWindow: [] })
	expect(await storedEntries(storage)).toEqual(
		entriesFor(records, "threadOrder"),
	)
	await renamed.close()
})

test("a reported outside write, or rebuildIndexes after an unreported one, restores entries", async () => {
	const storage = new NotifyingStorage()
	const server = new TandemServer({ schema: indexed, relations: {}, storage })
	const tx = server.transact()
	tx.set("messages", message("m1"))
	await server.commit(tx)

	// Another process writes a record and storage reports it.
	await storage.commit({
		set: [
			{
				key: ["record", "messages", "m2"],
				value: message("m2", { createdAt: 9 }),
			},
		],
	})
	const records = await server.query({ collection: "messages" })
	expect(await storedEntries(storage)).toEqual(entriesFor(records))

	// A write storage does not report leaves entries stale until a rebuild.
	storage.memory.commit({
		set: [
			{
				key: ["record", "messages", "m1"],
				value: message("m1", { threadId: "t3" }),
			},
		],
	})
	await server.rebuildIndexes()
	expect(await storedEntries(storage)).toEqual(
		entriesFor(await server.query({ collection: "messages" })),
	)
	await server.close()
})

test("an index must name fields the collection has", () => {
	expect(
		() =>
			new TandemServer({
				schema: defineSchema({
					messages: collection<Message>({
						fields: ["id", "threadId", "createdAt", "text"],
						// @ts-expect-error: not a field of Message
						indexes: { byAuthor: ["authorId"] },
					}),
				}),
				relations: {},
				storage: new TestTandemServerStorage<ChatSchema>(),
			}),
	).toThrow('Index "messages.byAuthor" names unknown field "authorId"')
	expectTypeOf<TandemTuple<ChatSchema>>().toExtend<{
		key: readonly unknown[]
	}>()
})
