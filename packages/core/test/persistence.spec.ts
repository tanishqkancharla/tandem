import { Gatekeeper } from "@tanishqkancharla/gatekeeper"
import {
	codec,
	collection,
	defineSchema,
	TandemClient,
} from "@tanishqkancharla/tandem-core"
import { describe, expect } from "vitest"
import { test, todo, type TestsSchema } from "./fixtures"

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

function buildClientGatekeeper<Client extends object>(client: Client) {
	return new Gatekeeper().add("client", () => client).build()
}

describe("TandemClient persistence", () => {
	test("reloads persisted records after recreating the app", async ({
		logger,
		makeStorage,
		rng,
	}) => {
		const firstStorage = makeStorage<TestsSchema>({ dbName: "persisted-todos" })
		await using firstGatekeeper = buildClientGatekeeper(
			new TandemClient<TestsSchema>({
				clientStorage: firstStorage,
				logger,
				rng: rng.create("persistent-client-1"),
			}),
		)
		const firstClient = firstGatekeeper.client
		await firstClient.ready

		// Commit records with the first client
		const tx = firstClient.transact()
		tx.set(
			"todos",
			todo("todo-1", { text: "Write the sync spec", priority: 2 }),
		)
		tx.set("todos", todo("todo-3", { text: "Fix the sync bug", priority: 3 }))
		await (
			await firstClient.commit(tx)
		).result
		await (
			await firstClient.flushClientStorage()
		).result
		await firstStorage.close()

		// A new client backed by the same storage sees the persisted records
		await using secondGatekeeper = buildClientGatekeeper(
			new TandemClient<TestsSchema>({
				clientStorage: makeStorage<TestsSchema>({
					dbName: "persisted-todos",
				}),
				logger,
				rng: rng.create("persistent-client-2"),
			}),
		)
		const secondClient = secondGatekeeper.client
		await secondClient.ready

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
		logger,
		makeStorage,
		rng,
	}) => {
		const dbName = rng.next("schema-codec-events")
		const firstStorage = makeStorage<TestsEventSchema>({
			dbName,
			schema: testsEventRuntimeSchema,
		})
		await using firstGatekeeper = buildClientGatekeeper(
			new TandemClient<TestsEventSchema>({
				schema: testsEventRuntimeSchema,
				relations: {},
				clientStorage: firstStorage,
				logger,
				rng: rng.create("schema-codec-client-1"),
			}),
		)
		const firstClient = firstGatekeeper.client
		await firstClient.ready

		// Commit an event whose runtime value relies on the schema-owned codec
		const event = {
			id: "event-1",
			title: "Planning",
			startAt: new EventStart("2026-05-04T12:00:00.000Z"),
		}
		const tx = firstClient.transact()
		tx.set("events", event)
		await (
			await firstClient.commit(tx)
		).result
		await (
			await firstClient.flushClientStorage()
		).result
		await firstStorage.close()

		await using secondGatekeeper = buildClientGatekeeper(
			new TandemClient<TestsEventSchema>({
				schema: testsEventRuntimeSchema,
				relations: {},
				clientStorage: makeStorage<TestsEventSchema>({
					dbName,
					schema: testsEventRuntimeSchema,
				}),
				logger,
				rng: rng.create("schema-codec-client-2"),
			}),
		)
		const secondClient = secondGatekeeper.client
		await secondClient.ready

		// Recreated storage decodes the persisted value back to the runtime shape
		const persistedEvents = secondClient.query({ collection: "events" })

		expect(persistedEvents).toEqual([event])
		expect(persistedEvents[0]?.startAt).toBeInstanceOf(EventStart)
	})

	test("keeps explicit IndexedDB codec support without a runtime schema", async ({
		logger,
		makeStorage,
		rng,
	}) => {
		const dbName = rng.next("explicit-codec-events")
		const firstStorage = makeStorage<TestsEventSchema>({
			dbName,
			codecs: { events: eventCodec },
		})
		await using firstGatekeeper = buildClientGatekeeper(
			new TandemClient<TestsEventSchema>({
				relations: {},
				clientStorage: firstStorage,
				logger,
				rng: rng.create("explicit-codec-client-1"),
			}),
		)
		const firstClient = firstGatekeeper.client
		await firstClient.ready

		// Existing explicit storage codecs still encode persisted writes
		const event = {
			id: "event-1",
			title: "Planning",
			startAt: new EventStart("2026-05-04T12:00:00.000Z"),
		}
		const tx = firstClient.transact()
		tx.set("events", event)
		await (
			await firstClient.commit(tx)
		).result
		await (
			await firstClient.flushClientStorage()
		).result
		await firstStorage.close()

		await using secondGatekeeper = buildClientGatekeeper(
			new TandemClient<TestsEventSchema>({
				relations: {},
				clientStorage: makeStorage<TestsEventSchema>({
					dbName,
					codecs: { events: eventCodec },
				}),
				logger,
				rng: rng.create("explicit-codec-client-2"),
			}),
		)
		const secondClient = secondGatekeeper.client
		await secondClient.ready

		// Recreated storage decodes through the explicit codec as before
		const persistedEvents = secondClient.query({ collection: "events" })

		expect(persistedEvents).toEqual([event])
		expect(persistedEvents[0]?.startAt).toBeInstanceOf(EventStart)
	})
})
