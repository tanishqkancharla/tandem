import {
	type LoggerApi,
	type RemoteApi,
	TandemClient,
} from "@tanishqkancharla/tandem-core"
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
} from "../fixtures"

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

describe("TandemClient sync", () => {
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
