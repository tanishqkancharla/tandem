import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import {
	type LoggerApi,
	type RemoteApi,
	TandemClient,
} from "@tanishqkancharla/tandem-core"
import {
	TandemServer,
	TandemServerJsonFileStorage,
} from "@tanishqkancharla/tandem-server"
import * as errore from "errore"
import { describe, expect, vi } from "vitest"
import {
	buildGatekeeperHarness,
	expectQuery,
	test,
	testsRuntimeSchema,
	todo,
	type DemoRng,
	type TestsSchema,
	type TestsTodo,
} from "../fixtures.js"

function createSchemaGatekeeper({
	server,
	logger,
	rng,
}: {
	server: RemoteApi<TestsSchema>
	logger: LoggerApi
	rng: DemoRng
}) {
	const clients: TandemClient<TestsSchema>[] = []
	const gatekeeper = buildGatekeeperHarness({
		server,
		createClient: (remote, label) => {
			const client = new TandemClient<TestsSchema>({
				remote,
				schema: testsRuntimeSchema,
				logger,
				rng: rng.create(label),
				autoConnect: false,
				syncInterval: 0,
			})
			clients.push(client)
			return client
		},
	})
	return { clients, gatekeeper }
}

const schemaSyncTest = test.extend<{
	schemaGatekeeper: ReturnType<typeof createSchemaGatekeeper>["gatekeeper"]
}>({
	schemaGatekeeper: async ({ server, logger, rng }, use) => {
		const { clients, gatekeeper } = createSchemaGatekeeper({
			server,
			logger,
			rng,
		})
		await using cleanup = new errore.AsyncDisposableStack()
		await using harness = gatekeeper

		for (const client of clients) {
			await client.ready
			await client.connect()
			cleanup.defer(() => client.disconnect())
		}

		await use(harness)
		await harness.deactivateGatesAndSettle()
	},
})

const externalStorageTest = test.extend<{
	backingStorage: TandemServerJsonFileStorage<TestsSchema>
	server: TandemServer<TestsSchema, {}>
}>({
	backingStorage: async ({}, use) => {
		const directory = await fs.mkdtemp(
			path.join(os.tmpdir(), "tandem-external-sync-"),
		)
		await using cleanup = new errore.AsyncDisposableStack()
		cleanup.defer(() => fs.rm(directory, { recursive: true, force: true }))
		await use(
			new TandemServerJsonFileStorage({
				filePath: path.join(directory, "storage.json"),
			}),
		)
	},
	server: async ({ backingStorage }, use) => {
		const server = new TandemServer({
			schema: testsRuntimeSchema,
			relations: {},
			storage: backingStorage,
		})
		await use(server)
		await server.close()
	},
})

describe("TandemClient sync", () => {
	externalStorageTest(
		"manual pulls and reconnects recover external writes for both clients",
		async ({ gatekeeper, server, backingStorage }) => {
			const { client1, client2 } = gatekeeper
			const query = { collection: "todos" } as const
			const original = todo("a", { text: "Original" })
			const removed = todo("b", { text: "Remove externally" })
			const seedTx = server.transact()
			seedTx.set("todos", original)
			seedTx.set("todos", removed)
			await server.commit(seedTx)
			for (const client of [client1, client2]) {
				client.subscribe(query)
				await (
					await client.pullFromRemote()
				).result
			}
			await gatekeeper.deactivateGatesAndSettle()

			// External updates, inserts, and removals arrive through either refresh path.
			const updated = todo("a", { text: "External update", done: true })
			const inserted = todo("c", { text: "External insert" })
			await backingStorage.commit({
				set: [updated, inserted].map((value) => ({
					key: ["record", "todos", value.id],
					value,
				})),
				remove: [["record", "todos", removed.id]],
			})
			await (
				await client1.pullFromRemote()
			).result
			await (
				await client2.disconnect()
			).result
			await (
				await client2.connect()
			).result
			expect(client1.query(query)).toEqual([updated, inserted])
			expect(client2.query(query)).toEqual([updated, inserted])

			// Swap refresh paths and remove every record, so an empty window clears old data too.
			await backingStorage.commit({
				remove: [updated, inserted].map((value) => [
					"record",
					"todos",
					value.id,
				]),
			})
			await (
				await client1.disconnect()
			).result
			await (
				await client1.connect()
			).result
			await (
				await client2.pullFromRemote()
			).result
			expect(client1.query(query)).toEqual([])
			expect(client2.query(query)).toEqual([])
		},
	)

	test("drops a confirmed write that no subscription covers", async ({
		gatekeeper,
	}) => {
		const { client1, client2 } = gatekeeper
		const client2Subscription = client2.subscribe({ collection: "todos" })

		// client1 writes a todo without subscribing to todos
		const tx = client1.transact()
		tx.set("todos", todo("todo-1", { text: "Unwatched" }))
		await (
			await client1.commit(tx)
		).result

		// Once a pull confirms the write, client1 keeps only what it subscribes to
		await (
			await client1.pullFromRemote()
		).result

		expect(client1.query({ collection: "todos" })).toEqual([])
		await expectQuery(client2, { collection: "todos" }).toResolveTo([
			todo("todo-1", { text: "Unwatched" }),
		])
		client2Subscription.destroy()
	})

	test("removes a record on the server that the client doesn't have", async ({
		gatekeeper,
	}) => {
		const { client1, client2 } = gatekeeper
		const client2Subscription = client2.subscribe({ collection: "todos" })
		const seedTx = client2.transact()
		seedTx.set("todos", todo("todo-1", { text: "Removed remotely" }))
		await (
			await client2.commit(seedTx)
		).result

		// client1 never received todo-1, but can still remove it by id
		const removeTx = client1.transact()
		removeTx.remove("todos", "todo-1")
		await (
			await client1.commit(removeTx)
		).result

		await expectQuery(client2, { collection: "todos" }).toResolveTo([])
		client2Subscription.destroy()
	})

	test("syncs a committed change from one client to another subscribed client", async ({
		gatekeeper,
	}) => {
		const { client1, client2 } = gatekeeper
		const seenByClient2: TestsTodo[][] = []
		client2.subscribe({ collection: "todos" }, (result) => {
			seenByClient2.push(result)
		})

		// A commit on client1 is synced to client2's subscription
		const tx = client1.transact()
		tx.set(
			"todos",
			todo("todo-1", { text: "Write the sync spec", priority: 2 }),
		)
		await (
			await client1.commit(tx)
		).result

		await vi.waitFor(() => {
			expect(seenByClient2).toEqual([
				[todo("todo-1", { text: "Write the sync spec", priority: 2 })],
			])
		})

		// The synced record is also queryable directly on client2
		await expectQuery(client2, {
			collection: "todos",
			where: { id: "todo-1" },
			limit: 1,
		}).toResolveTo([
			todo("todo-1", { text: "Write the sync spec", priority: 2 }),
		])
	})

	schemaSyncTest(
		"syncs flat subscription updates unchanged when constructed with a runtime schema",
		async ({ schemaGatekeeper }) => {
			const { client1: schemaClient1, client2: schemaClient2 } =
				schemaGatekeeper

			const seenByClient2: TestsTodo[][] = []
			schemaClient2.subscribe({ collection: "todos" }, (result) => {
				seenByClient2.push(result)
			})

			// A flat commit on one schema-enabled client still reaches another flat subscription
			const tx = schemaClient1.transact()
			tx.set(
				"todos",
				todo("todo-1", { text: "Write the sync spec", priority: 2 }),
			)
			await (
				await schemaClient1.commit(tx)
			).result

			await vi.waitFor(() => {
				expect(seenByClient2).toEqual([
					[todo("todo-1", { text: "Write the sync spec", priority: 2 })],
				])
			})

			// The synced record remains queryable through the object query API
			await expectQuery(schemaClient2, {
				collection: "todos",
				where: { id: "todo-1" },
				limit: 1,
			}).toResolveTo([
				todo("todo-1", { text: "Write the sync spec", priority: 2 }),
			])
		},
	)

	test("syncs remote updates that move records out of subscribed where filters", async ({
		gatekeeper,
	}) => {
		const { client1, client2 } = gatekeeper
		const seenByClient2: TestsTodo[][] = []
		client2.subscribe(
			{ collection: "todos", where: { done: false } },
			(result) => {
				seenByClient2.push(result)
			},
		)

		// A matching remote record enters the subscribed result
		const seedTx = client1.transact()
		seedTx.set(
			"todos",
			todo("todo-1", { text: "Write the sync spec", priority: 2 }),
		)
		await (
			await client1.commit(seedTx)
		).result

		await vi.waitFor(() => {
			expect(seenByClient2).toEqual([
				[todo("todo-1", { text: "Write the sync spec", priority: 2 })],
			])
		})

		// Updating the record so it no longer matches removes it from the subscription
		const completeTx = client1.transact()
		completeTx.set(
			"todos",
			todo("todo-1", {
				text: "Write the sync spec",
				done: true,
				priority: 2,
			}),
		)
		await (
			await client1.commit(completeTx)
		).result

		await vi.waitFor(() => {
			expect(seenByClient2).toEqual([
				[todo("todo-1", { text: "Write the sync spec", priority: 2 })],
				[],
			])
		})
	})
})
