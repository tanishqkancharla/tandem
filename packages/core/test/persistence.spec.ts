import { codec, collection, defineSchema } from "@tanishqkancharla/tandem-core"
import { describe, expect } from "vitest"
import { test, todo } from "./fixtures"

class EventStart {
	constructor(readonly iso: string) {}
}

type TestsEvent = {
	id: string
	title: string
	startAt: EventStart
}

type TestsEventStorageValue = {
	id: string
	title: string
	startAt: string
}

type TestsEventSchema = {
	events: TestsEvent
}

const eventCodec = codec<TestsEvent, TestsEventStorageValue>(
	"event",
	(input) => {
		const event = input as TestsEvent
		return {
			...event,
			startAt: event.startAt.iso,
		}
	},
	(input) => {
		const event = input as TestsEventStorageValue
		return {
			...event,
			startAt: new EventStart(event.startAt),
		}
	},
)

const testsEventRuntimeSchema = defineSchema({
	events: collection<TestsEvent, TestsEventStorageValue>({
		fields: ["id", "title", "startAt"],
		codec: eventCodec,
	}),
})

describe("TandemClient persistence", () => {
	test("reloads persisted records after recreating the app", async ({
		makeClient,
	}) => {
		// Commit records with the first client
		const firstClient = await makeClient({
			label: "persistent-client-1",
			remote: false,
			clientStorage: { dbName: "persisted-todos" },
		})

		const tx = firstClient.transact()
		tx.set(
			"todos",
			todo("todo-1", { text: "Write the sync spec", priority: 2 }),
		)
		tx.set("todos", todo("todo-3", { text: "Fix the sync bug", priority: 3 }))
		await firstClient.commit(tx)
		await firstClient.flushClientStorage()

		// A new client backed by the same storage sees the persisted records
		const secondClient = await makeClient({
			label: "persistent-client-2",
			remote: false,
			clientStorage: { dbName: "persisted-todos" },
		})

		const persistedTodosOnReload = secondClient.query({
			collection: "todos",
			orderBy: { priority: "asc" },
		})

		expect(persistedTodosOnReload).toEqual([
			todo("todo-1", { text: "Write the sync spec", priority: 2 }),
			todo("todo-3", { text: "Fix the sync bug", priority: 3 }),
		])
	})

	test("reloads persisted records through schema-owned codecs", async ({
		makeClient,
		makeStorage,
		rng,
	}) => {
		const dbName = rng.next("schema-codec-events")
		const firstStorage = makeStorage<TestsEventSchema>({
			dbName,
			schema: testsEventRuntimeSchema,
		})
		const firstClient = await makeClient.withSchema({
			label: "schema-codec-client-1",
			remote: false,
			schema: testsEventRuntimeSchema,
			relations: {},
			clientStorage: firstStorage,
		})

		// Commit an event whose runtime value relies on the schema-owned codec
		const event = {
			id: "event-1",
			title: "Planning",
			startAt: new EventStart("2026-05-04T12:00:00.000Z"),
		}
		const tx = firstClient.transact()
		tx.set("events", event)
		await firstClient.commit(tx)
		await firstClient.flushClientStorage()
		await firstStorage.close()

		const secondClient = await makeClient.withSchema({
			label: "schema-codec-client-2",
			remote: false,
			schema: testsEventRuntimeSchema,
			relations: {},
			clientStorage: makeStorage<TestsEventSchema>({
				dbName,
				schema: testsEventRuntimeSchema,
			}),
		})

		// Recreated storage decodes the persisted value back to the runtime shape
		const persistedEvents = secondClient.query({ collection: "events" })

		expect(persistedEvents).toEqual([event])
		expect(persistedEvents[0]?.startAt).toBeInstanceOf(EventStart)
	})

	test("keeps explicit IndexedDB codec support without a runtime schema", async ({
		makeClient,
		makeStorage,
		rng,
	}) => {
		const dbName = rng.next("explicit-codec-events")
		const firstStorage = makeStorage<TestsEventSchema>({
			dbName,
			codecs: { events: eventCodec },
		})
		const firstClient = await makeClient.withSchema<TestsEventSchema>({
			label: "explicit-codec-client-1",
			remote: false,
			relations: {},
			clientStorage: firstStorage,
		})

		// Existing explicit storage codecs still encode persisted writes
		const event = {
			id: "event-1",
			title: "Planning",
			startAt: new EventStart("2026-05-04T12:00:00.000Z"),
		}
		const tx = firstClient.transact()
		tx.set("events", event)
		await firstClient.commit(tx)
		await firstClient.flushClientStorage()
		await firstStorage.close()

		const secondClient = await makeClient.withSchema<TestsEventSchema>({
			label: "explicit-codec-client-2",
			remote: false,
			relations: {},
			clientStorage: makeStorage<TestsEventSchema>({
				dbName,
				codecs: { events: eventCodec },
			}),
		})

		// Recreated storage decodes through the explicit codec as before
		const persistedEvents = secondClient.query({ collection: "events" })

		expect(persistedEvents).toEqual([event])
		expect(persistedEvents[0]?.startAt).toBeInstanceOf(EventStart)
	})
})
