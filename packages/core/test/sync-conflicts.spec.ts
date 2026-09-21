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
	todo,
	type DemoRng,
	type TestsSchema,
	type TestsTodo,
} from "./fixtures"

type ThreadSchema = {
	threads: {
		id: string
		ownerId: string
		title: string
		status: "active" | "archived"
	}
	messages: { id: string; threadId: string; body: string; createdAt: number }
}

const threadSchema = defineSchema({
	threads: collection<ThreadSchema["threads"]>({
		fields: ["id", "ownerId", "title", "status"],
	}),
	messages: collection<ThreadSchema["messages"]>({
		fields: ["id", "threadId", "body", "createdAt"],
	}),
})

const threadRelations = defineRelations(threadSchema, ({ many }) => ({
	threads: {
		messages: many("messages", { from: "id", to: "threadId" }),
	},
}))

function createTodoGatekeeper({
	remote,
	logger,
	rng,
}: {
	remote: RemoteApi<TestsSchema>
	logger: LoggerApi
	rng: DemoRng
}) {
	const clients: TandemClient<TestsSchema>[] = []
	const gatekeeper = buildGatekeeperHarness({
		server: remote,
		createClient: (server, label) => {
			const client = new TandemClient<TestsSchema>({
				remote: server,
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
	remote,
	logger,
	rng,
}: {
	remote: RemoteApi<ThreadSchema>
	logger: LoggerApi
	rng: DemoRng
}) {
	const clients: TandemClient<ThreadSchema, typeof threadRelations>[] = []
	const gatekeeper = buildGatekeeperHarness({
		server: remote,
		createClient: (server, label) => {
			const client = new TandemClient<ThreadSchema, typeof threadRelations>({
				remote: server,
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

type ClientName = "client1" | "client2"
type TodoGatekeeper = ReturnType<typeof createTodoGatekeeper>["gatekeeper"]
type ThreadGatekeeper = ReturnType<typeof createThreadGatekeeper>["gatekeeper"]

const conflictTest = test.extend<{
	makeTodoGatekeeper: (args: {
		remote: RemoteApi<TestsSchema>
		connect?: readonly ClientName[]
	}) => Promise<TodoGatekeeper>
	makeThreadGatekeeper: (args: {
		remote: RemoteApi<ThreadSchema>
	}) => Promise<ThreadGatekeeper>
}>({
	makeTodoGatekeeper: async ({ logger, rng }, use) => {
		await using cleanup = new errore.AsyncDisposableStack()

		await use(async ({ remote, connect = ["client1", "client2"] }) => {
			const { clients, gatekeeper } = createTodoGatekeeper({
				remote,
				logger,
				rng,
			})
			const connectedClients = clients.filter((_, index) =>
				connect.includes(index === 0 ? "client1" : "client2"),
			)
			cleanup.defer(async () => {
				await gatekeeper.deactivateGatesAndSettle()
				await Promise.all(connectedClients.map((client) => client.disconnect()))
				await gatekeeper[Symbol.asyncDispose]()
			})

			await Promise.all(clients.map((client) => client.ready))
			await Promise.all(connectedClients.map((client) => client.connect()))
			return gatekeeper
		})
	},

	makeThreadGatekeeper: async ({ logger, rng }, use) => {
		await using cleanup = new errore.AsyncDisposableStack()

		await use(async ({ remote }) => {
			const { clients, gatekeeper } = createThreadGatekeeper({
				remote,
				logger,
				rng,
			})
			cleanup.defer(async () => {
				await gatekeeper.deactivateGatesAndSettle()
				await Promise.all(clients.map((client) => client.disconnect()))
				await gatekeeper[Symbol.asyncDispose]()
			})

			await Promise.all(clients.map((client) => client.ready))
			await Promise.all(clients.map((client) => client.connect()))
			return gatekeeper
		})
	},
})

describe("TandemClient sync conflicts", () => {
	test("rolls back an optimistic write when the server rejects the push", async ({
		gatekeeper,
	}) => {
		const { client1 } = gatekeeper
		const offlineDraft = todo("offline-todo", {
			text: "Write while offline",
			priority: 1,
		})
		let latestResult: TestsTodo[] | undefined
		client1.subscribe({ collection: "todos" }, (result) => {
			latestResult = result
		})
		await gatekeeper.activateGates()

		const tx = client1.transact()
		tx.set("todos", offlineDraft)
		const commit = await client1.commit(tx)

		expect(client1.query({ collection: "todos" })).toEqual([offlineDraft])
		expect(latestResult).toEqual([offlineDraft])

		const failure = new Error("offline")
		await commit.fail(failure)

		await expect(commit.result).rejects.toBe(failure)
		expect(latestResult).toEqual([])
		expect(client1.query({ collection: "todos" })).toEqual([])
	})

	conflictTest(
		"keeps pending mutations queued while disconnected and pushes them after reconnect",
		async ({ makeTodoGatekeeper, server }) => {
			const gatekeeper = await makeTodoGatekeeper({
				remote: server,
				connect: ["client2"],
			})
			const { client1, client2 } = gatekeeper
			client2.subscribe({ collection: "todos" })

			const tx = client1.transact()
			tx.set("todos", todo("todo-1", { text: "Write while disconnected" }))
			const commit = await client1.commit(tx)
			await commit.result
			const pullBeforeConnect = await client2.pullFromRemote()
			await pullBeforeConnect.result

			expect(client2.query({ collection: "todos" })).toEqual([])

			const connect = await client1.connect()
			await connect.result

			await expectQuery(client2, { collection: "todos" }).toResolveTo([
				todo("todo-1", { text: "Write while disconnected" }),
			])
		},
	)

	conflictTest(
		"replays a pending local edit on top of a newer remote patch",
		async ({ makeTodoGatekeeper, server }) => {
			const gate = Promise.withResolvers<void>()
			let delayedClientId = ""
			let delayedPushStarted = false
			const delayedServer: RemoteApi<TestsSchema> = {
				connect: (client) => server.connect(client),
				pull: (args) => server.pull(args),
				push: async (args) => {
					if (args.clientId === delayedClientId) {
						delayedPushStarted = true
						await gate.promise
					}
					return server.push(args)
				},
			}
			const gatekeeper = await makeTodoGatekeeper({ remote: delayedServer })
			const { client1, client2 } = gatekeeper
			delayedClientId = client2.clientId
			client1.subscribe({ collection: "todos" })
			client2.subscribe({ collection: "todos" })

			const seedTx = client1.transact()
			seedTx.set(
				"todos",
				todo("todo-1", { text: "Write the sync spec", priority: 2 }),
			)
			const seed = await client1.commit(seedTx)
			await seed.result
			await expectQuery(client2, { collection: "todos" }).toResolveTo([
				todo("todo-1", { text: "Write the sync spec", priority: 2 }),
			])
			await gatekeeper.activateGates()

			const localEditTx = client2.transact()
			localEditTx.set(
				"todos",
				todo("todo-1", { text: "Local edit on client 2", priority: 2 }),
			)
			const pendingCommit = await client2.commit(localEditTx)
			const pendingPush = pendingCommit.continueTo("server")
			await vi.waitFor(() => expect(delayedPushStarted).toBe(true))

			const remoteEditTx = client1.transact()
			remoteEditTx.set(
				"todos",
				todo("todo-1", {
					text: "Remote edit on client 1",
					done: true,
					priority: 5,
				}),
			)
			const remoteEdit = await client1.commit(remoteEditTx)
			await remoteEdit.continueToCompletion()
			await remoteEdit.result

			await expectQuery(client2, { collection: "todos" }).toResolveTo([
				todo("todo-1", { text: "Local edit on client 2", priority: 2 }),
			])

			gate.resolve()
			await pendingPush
			await pendingCommit.continueToCompletion()
			await pendingCommit.result
			await expectQuery(client1, { collection: "todos" }).toResolveTo([
				todo("todo-1", { text: "Local edit on client 2", priority: 2 }),
			])
		},
	)

	conflictTest(
		"replays a pending included relation edit on top of a newer remote patch",
		async ({ makeRemote, makeThreadGatekeeper }) => {
			const server = makeRemote({
				schema: threadSchema,
				relations: threadRelations,
			})
			const gate = Promise.withResolvers<void>()
			let delayedClientId = ""
			let delayedPushStarted = false
			const delayedServer: RemoteApi<ThreadSchema> = {
				connect: (client) => server.connect(client),
				pull: (args) => server.pull(args),
				push: async (args) => {
					if (args.clientId === delayedClientId) {
						delayedPushStarted = true
						await gate.promise
					}
					return server.push(args)
				},
			}
			const gatekeeper = await makeThreadGatekeeper({ remote: delayedServer })
			const { client1, client2 } = gatekeeper
			delayedClientId = client2.clientId
			const threadWithMessagesQuery = {
				collection: "threads",
				select: { id: true },
				with: {
					messages: {
						select: { body: true },
						orderBy: { createdAt: "asc" },
					},
				},
			} as const
			const seenByClient2: { id: string; messages: { body: string }[] }[][] = []
			client1.subscribe(threadWithMessagesQuery)
			client2.subscribe(threadWithMessagesQuery, (result) => {
				seenByClient2.push(result)
			})

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
				body: "Original message",
				createdAt: 1,
			})
			const seed = await client1.commit(seedTx)
			await seed.result
			await expectQuery(client2, threadWithMessagesQuery).toResolveTo([
				{ id: "thread-1", messages: [{ body: "Original message" }] },
			])
			await gatekeeper.activateGates()

			const localEditTx = client2.transact()
			localEditTx.set("messages", {
				id: "message-1",
				threadId: "thread-1",
				body: "Local included edit",
				createdAt: 1,
			})
			const pendingCommit = await client2.commit(localEditTx)
			const pendingPush = pendingCommit.continueTo("server")
			await vi.waitFor(() => expect(delayedPushStarted).toBe(true))

			const remoteEditTx = client1.transact()
			remoteEditTx.set("messages", {
				id: "message-1",
				threadId: "thread-1",
				body: "Remote included edit",
				createdAt: 1,
			})
			const remoteEdit = await client1.commit(remoteEditTx)
			await remoteEdit.continueToCompletion()
			await remoteEdit.result
			const expectedRebasedRows = [
				{ id: "thread-1", messages: [{ body: "Local included edit" }] },
			]

			await expectQuery(client2, threadWithMessagesQuery).toResolveTo(
				expectedRebasedRows,
			)
			expect(seenByClient2.at(-1)).toEqual(expectedRebasedRows)

			gate.resolve()
			await pendingPush
			await pendingCommit.continueToCompletion()
			await pendingCommit.result
			await expectQuery(client1, threadWithMessagesQuery).toResolveTo(
				expectedRebasedRows,
			)
		},
	)
})
