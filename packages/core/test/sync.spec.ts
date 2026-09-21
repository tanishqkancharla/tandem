import {
	collection,
	defineRelations,
	defineSchema,
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
} from "./fixtures"

type ThreadSchema = {
	users: { id: string; profileId: string; name: string }
	profiles: { id: string; displayName: string }
	threads: {
		id: string
		ownerId: string
		title: string
		status: "active" | "archived"
	}
	messages: { id: string; threadId: string; body: string; createdAt: number }
}

const threadSchema = defineSchema({
	users: collection<ThreadSchema["users"]>({
		fields: ["id", "profileId", "name"],
	}),
	profiles: collection<ThreadSchema["profiles"]>({
		fields: ["id", "displayName"],
	}),
	threads: collection<ThreadSchema["threads"]>({
		fields: ["id", "ownerId", "title", "status"],
	}),
	messages: collection<ThreadSchema["messages"]>({
		fields: ["id", "threadId", "body", "createdAt"],
	}),
})

const threadRelations = defineRelations(threadSchema, ({ one, many }) => ({
	users: {
		profile: one("profiles", { from: "profileId", to: "id" }),
	},
	threads: {
		owner: one("users", { from: "ownerId", to: "id" }),
		messages: many("messages", { from: "id", to: "threadId" }),
	},
}))

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

function createThreadGatekeeper({
	server,
	logger,
	rng,
}: {
	server: RemoteApi<ThreadSchema>
	logger: LoggerApi
	rng: DemoRng
}) {
	const clients: TandemClient<ThreadSchema, typeof threadRelations>[] = []
	const gatekeeper = buildGatekeeperHarness({
		server,
		createClient: (remote, label) => {
			const client = new TandemClient<ThreadSchema, typeof threadRelations>({
				remote,
				schema: threadSchema,
				relations: threadRelations,
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

const threadSyncTest = test.extend<{
	threadGatekeeper: ReturnType<typeof createThreadGatekeeper>["gatekeeper"]
}>({
	threadGatekeeper: async ({ makeRemote, logger, rng }, use) => {
		const server = makeRemote({
			schema: threadSchema,
			relations: threadRelations,
		})
		const { clients, gatekeeper } = createThreadGatekeeper({
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

	threadSyncTest(
		"pulls relational snapshots after subscribing with an advanced cookie",
		async ({ threadGatekeeper }) => {
			const { client1, client2 } = threadGatekeeper

			// Client1 seeds related records before client2 has any scan-window subscription
			const seedTx = client1.transact()
			seedTx.set("profiles", { id: "profile-1", displayName: "Ada Lovelace" })
			seedTx.set("users", { id: "user-1", profileId: "profile-1", name: "Ada" })
			seedTx.set("threads", {
				id: "thread-1",
				ownerId: "user-1",
				title: "Active thread",
				status: "active",
			})
			seedTx.set("messages", {
				id: "message-1",
				threadId: "thread-1",
				body: "Hello",
				createdAt: 1,
			})
			await (
				await client1.commit(seedTx)
			).result

			// Pulling with an empty scan window advances the cookie without loading records
			await (
				await client2.pullFromRemote()
			).result
			expect(client2.query({ collection: "threads" })).toEqual([])

			const seenByClient2: {
				id: string
				title: string
				owner: { name: string; profile: { displayName: string } | null } | null
				messages: { id: string }[]
			}[][] = []
			client2.subscribe(
				{
					collection: "threads",
					select: { id: true, title: true },
					with: {
						owner: {
							select: { name: true },
							with: { profile: { select: { displayName: true } } },
						},
						messages: { select: { id: true } },
					},
				},
				(result) => {
					seenByClient2.push(result)
				},
			)

			// Subscribing pulls a snapshot for the root and included collections despite the advanced cookie
			await (
				await client2.pullFromRemote()
			).result
			await vi.waitFor(() => {
				expect(seenByClient2).toEqual([
					[
						{
							id: "thread-1",
							title: "Active thread",
							owner: {
								name: "Ada",
								profile: { displayName: "Ada Lovelace" },
							},
							messages: [{ id: "message-1" }],
						},
					],
				])
			})
		},
	)

	threadSyncTest(
		"applies snapshot where filters while storing full records",
		async ({ threadGatekeeper }) => {
			const { client1, client2 } = threadGatekeeper

			// Client1 seeds one thread with two child messages before client2 subscribes
			const seedTx = client1.transact()
			seedTx.set("threads", {
				id: "thread-1",
				ownerId: "user-1",
				title: "Active thread",
				status: "active",
			})
			seedTx.set("messages", {
				id: "message-1",
				threadId: "thread-1",
				body: "Older message",
				createdAt: 1,
			})
			seedTx.set("messages", {
				id: "message-2",
				threadId: "thread-1",
				body: "Newer message",
				createdAt: 2,
			})
			await (
				await client1.commit(seedTx)
			).result

			// Pulling with an empty scan window advances the cookie without loading records
			await (
				await client2.pullFromRemote()
			).result
			expect(client2.query({ collection: "messages" })).toEqual([])

			const seenByClient2: {
				id: string
				messages: { body: string }[]
			}[][] = []
			client2.subscribe(
				{
					collection: "threads",
					select: { id: true },
					with: {
						messages: {
							select: { body: true },
							where: { createdAt: { gt: 1 } },
						},
					},
				},
				(result) => {
					seenByClient2.push(result)
				},
			)

			// The snapshot applies where filters before storing full records locally
			await (
				await client2.pullFromRemote()
			).result
			await vi.waitFor(() => {
				expect(seenByClient2).toEqual([
					[{ id: "thread-1", messages: [{ body: "Newer message" }] }],
				])
			})

			// Projection is ignored for storage so future local queries have complete records
			await expectQuery(client2, { collection: "messages" }).toResolveTo([
				{
					id: "message-2",
					threadId: "thread-1",
					body: "Newer message",
					createdAt: 2,
				},
			])
		},
	)

	threadSyncTest(
		"syncs remote one-to-many relation changes into subscribed results",
		async ({ threadGatekeeper }) => {
			const { client1, client2 } = threadGatekeeper

			const seenByClient2: { id: string; messages: { body: string }[] }[][] = []
			client2.subscribe(
				{
					collection: "threads",
					select: { id: true },
					with: {
						messages: {
							select: { body: true },
							orderBy: { createdAt: "asc" },
						},
					},
				},
				(result) => {
					seenByClient2.push(result)
				},
			)
			await (
				await client2.pullFromRemote()
			).result

			// A remote parent appears first with an empty included relation array
			const seedTx = client1.transact()
			seedTx.set("threads", {
				id: "thread-1",
				ownerId: "user-1",
				title: "Active thread",
				status: "active",
			})
			await (
				await client1.commit(seedTx)
			).result

			await vi.waitFor(() => {
				expect(seenByClient2).toEqual([[{ id: "thread-1", messages: [] }]])
			})

			// A remote child mutation re-emits the parent row with embedded child results
			const addMessageTx = client1.transact()
			addMessageTx.set("messages", {
				id: "message-1",
				threadId: "thread-1",
				body: "First message",
				createdAt: 1,
			})
			await (
				await client1.commit(addMessageTx)
			).result

			await vi.waitFor(() => {
				expect(seenByClient2).toEqual([
					[{ id: "thread-1", messages: [] }],
					[{ id: "thread-1", messages: [{ body: "First message" }] }],
				])
			})

			// The synced child record is queryable directly on the subscribed client
			await expectQuery(client2, { collection: "messages" }).toResolveTo([
				{
					id: "message-1",
					threadId: "thread-1",
					body: "First message",
					createdAt: 1,
				},
			])
		},
	)

	threadSyncTest(
		"syncs remote one-to-many relation removals into subscribed results",
		async ({ threadGatekeeper }) => {
			const { client1, client2 } = threadGatekeeper

			const seenByClient2: { id: string; messages: { body: string }[] }[][] = []
			client2.subscribe(
				{
					collection: "threads",
					select: { id: true },
					with: { messages: { select: { body: true } } },
				},
				(result) => {
					seenByClient2.push(result)
				},
			)
			await (
				await client2.pullFromRemote()
			).result

			// Seed a parent and included child, then wait for client2 to sync them
			const seedTx = client1.transact()
			seedTx.set("threads", {
				id: "thread-1",
				ownerId: "user-1",
				title: "Active thread",
				status: "active",
			})
			seedTx.set("messages", {
				id: "message-1",
				threadId: "thread-1",
				body: "First message",
				createdAt: 1,
			})
			await (
				await client1.commit(seedTx)
			).result

			await vi.waitFor(() => {
				expect(seenByClient2).toEqual([
					[{ id: "thread-1", messages: [{ body: "First message" }] }],
				])
			})

			// Removing the included child should re-emit the parent with an empty relation array
			const removeMessageTx = client1.transact()
			removeMessageTx.remove("messages", "message-1")
			await (
				await client1.commit(removeMessageTx)
			).result

			await vi.waitFor(() => {
				expect(seenByClient2).toEqual([
					[{ id: "thread-1", messages: [{ body: "First message" }] }],
					[{ id: "thread-1", messages: [] }],
				])
			})
		},
	)

	threadSyncTest(
		"syncs remote nested relation changes into subscribed results",
		async ({ threadGatekeeper }) => {
			const { client1, client2 } = threadGatekeeper

			const seenByClient2: {
				id: string
				owner: { name: string; profile: { displayName: string } | null } | null
			}[][] = []
			client2.subscribe(
				{
					collection: "threads",
					select: { id: true },
					with: {
						owner: {
							select: { name: true },
							with: { profile: { select: { displayName: true } } },
						},
					},
				},
				(result) => {
					seenByClient2.push(result)
				},
			)
			await (
				await client2.pullFromRemote()
			).result

			// Seed a parent with a many-to-one owner and nested profile
			const seedTx = client1.transact()
			seedTx.set("profiles", { id: "profile-1", displayName: "Ada Lovelace" })
			seedTx.set("users", { id: "user-1", profileId: "profile-1", name: "Ada" })
			seedTx.set("threads", {
				id: "thread-1",
				ownerId: "user-1",
				title: "Active thread",
				status: "active",
			})
			await (
				await client1.commit(seedTx)
			).result

			await vi.waitFor(() => {
				expect(seenByClient2).toEqual([
					[
						{
							id: "thread-1",
							owner: {
								name: "Ada",
								profile: { displayName: "Ada Lovelace" },
							},
						},
					],
				])
			})

			// A remote nested child mutation re-emits the parent row with updated nested data
			const updateProfileTx = client1.transact()
			updateProfileTx.set("profiles", {
				id: "profile-1",
				displayName: "Countess Lovelace",
			})
			await (
				await client1.commit(updateProfileTx)
			).result

			await vi.waitFor(() => {
				expect(seenByClient2).toEqual([
					[
						{
							id: "thread-1",
							owner: {
								name: "Ada",
								profile: { displayName: "Ada Lovelace" },
							},
						},
					],
					[
						{
							id: "thread-1",
							owner: {
								name: "Ada",
								profile: { displayName: "Countess Lovelace" },
							},
						},
					],
				])
			})

			// The synced nested child record is queryable directly on the subscribed client
			await expectQuery(client2, { collection: "profiles" }).toResolveTo([
				{ id: "profile-1", displayName: "Countess Lovelace" },
			])
		},
	)
})
