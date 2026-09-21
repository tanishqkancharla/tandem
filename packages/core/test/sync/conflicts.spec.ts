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
	todo,
	type DemoRng,
	type TestsSchema,
	type TestsTodo,
} from "../fixtures"

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

type ClientName = "client1" | "client2"
type TodoGatekeeper = ReturnType<typeof createTodoGatekeeper>["gatekeeper"]
const conflictTest = test.extend<{
	makeTodoGatekeeper: (args: {
		remote: RemoteApi<TestsSchema>
		connect?: readonly ClientName[]
	}) => Promise<TodoGatekeeper>
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

	test("recovers local and remote changes after disconnecting and reconnecting", async ({
		gatekeeper,
	}) => {
		const { client1, client2 } = gatekeeper
		const client1Subscription = client1.subscribe({ collection: "todos" })
		const client2Subscription = client2.subscribe({ collection: "todos" })
		await (
			await client1.disconnect()
		).result

		// The connected client advances the server while client1 is offline
		const remoteTx = client2.transact()
		remoteTx.set("todos", todo("remote", { text: "Written remotely" }))
		await (
			await client2.commit(remoteTx)
		).result

		// Client1 keeps its local optimistic change queued while disconnected
		const localTx = client1.transact()
		localTx.set("todos", todo("local", { text: "Written offline" }))
		await (
			await client1.commit(localTx)
		).result

		expect(client1.query({ collection: "todos" })).toEqual([
			todo("local", { text: "Written offline" }),
		])

		// Reconnecting pulls the missed remote change and pushes the queued local change
		await (
			await client1.connect()
		).result

		const convergedTodos = [
			todo("local", { text: "Written offline" }),
			todo("remote", { text: "Written remotely" }),
		]
		await expectQuery(client1, { collection: "todos" }).toResolveTo(
			convergedTodos,
		)
		await expectQuery(client2, { collection: "todos" }).toResolveTo(
			convergedTodos,
		)
		client1Subscription.destroy()
		client2Subscription.destroy()
	})

	conflictTest(
		"recovers from a transient pull failure on the next pull",
		async ({ makeTodoGatekeeper, server }) => {
			let failingClientId = ""
			let shouldFail = false
			let failedPulls = 0
			const failure = new Error("Temporary pull failure")
			const unreliableRemote: RemoteApi<TestsSchema> = {
				connect: (client) => server.connect(client),
				push: (args) => server.push(args),
				pull: (args) => {
					if (shouldFail && args.clientId === failingClientId) {
						shouldFail = false
						failedPulls += 1
						return Promise.reject(failure)
					}
					return server.pull(args)
				},
			}
			const gatekeeper = await makeTodoGatekeeper({ remote: unreliableRemote })
			const { client1, client2 } = gatekeeper
			failingClientId = client2.clientId
			const subscription = client2.subscribe({ collection: "todos" })
			await (
				await client2.pullFromRemote()
			).result
			shouldFail = true

			// The server poke reaches client2, but its first pull fails
			const tx = client1.transact()
			tx.set("todos", todo("todo-1", { text: "Retry this pull" }))
			await (
				await client1.commit(tx)
			).result
			await vi.waitFor(() => expect(failedPulls).toBe(1))

			expect(client2.query({ collection: "todos" })).toEqual([])

			// A later pull succeeds without reconstructing the client
			await (
				await client2.pullFromRemote()
			).result

			expect(client2.query({ collection: "todos" })).toEqual([
				todo("todo-1", { text: "Retry this pull" }),
			])
			subscription.destroy()
		},
	)

	test("converges after both clients edit the same record concurrently", async ({
		gatekeeper,
	}) => {
		const { client1, client2 } = gatekeeper
		const client1Subscription = client1.subscribe({ collection: "todos" })
		const client2Subscription = client2.subscribe({ collection: "todos" })
		const seedTx = client1.transact()
		seedTx.set("todos", todo("shared", { text: "Original" }))
		await (
			await client1.commit(seedTx)
		).result
		await expectQuery(client2, { collection: "todos" }).toResolveTo([
			todo("shared", { text: "Original" }),
		])
		await gatekeeper.activateGates()

		// Both clients optimistically replace the same server record
		const client1Tx = client1.transact()
		client1Tx.set("todos", todo("shared", { text: "Client 1 edit" }))
		const client1Commit = await client1.commit(client1Tx)
		const client2Tx = client2.transact()
		client2Tx.set("todos", todo("shared", { text: "Client 2 edit" }))
		const client2Commit = await client2.commit(client2Tx)

		// Applying client2 last establishes the canonical record
		await client1Commit.continueToCompletion()
		await client2Commit.continueToCompletion()
		const client1Pull = await client1.pullFromRemote()
		await client1Pull.continueToCompletion()
		const client2Pull = await client2.pullFromRemote()
		await client2Pull.continueToCompletion()

		const canonicalTodos = [todo("shared", { text: "Client 2 edit" })]
		expect(client1.query({ collection: "todos" })).toEqual(canonicalTodos)
		expect(client2.query({ collection: "todos" })).toEqual(canonicalTodos)
		client1Subscription.destroy()
		client2Subscription.destroy()
	})

	test("converges after clients concurrently edit different records", async ({
		gatekeeper,
	}) => {
		const { client1, client2 } = gatekeeper
		const client1Subscription = client1.subscribe({ collection: "todos" })
		const client2Subscription = client2.subscribe({ collection: "todos" })
		await gatekeeper.activateGates()

		// Each client optimistically creates an independent record
		const client1Tx = client1.transact()
		client1Tx.set("todos", todo("client-1", { text: "From client 1" }))
		const client1Commit = await client1.commit(client1Tx)
		const client2Tx = client2.transact()
		client2Tx.set("todos", todo("client-2", { text: "From client 2" }))
		const client2Commit = await client2.commit(client2Tx)

		await client1Commit.continueToCompletion()
		await client2Commit.continueToCompletion()
		const client1Pull = await client1.pullFromRemote()
		await client1Pull.continueToCompletion()
		const client2Pull = await client2.pullFromRemote()
		await client2Pull.continueToCompletion()

		const canonicalTodos = [
			todo("client-1", { text: "From client 1" }),
			todo("client-2", { text: "From client 2" }),
		]
		expect(client1.query({ collection: "todos" })).toEqual(canonicalTodos)
		expect(client2.query({ collection: "todos" })).toEqual(canonicalTodos)
		client1Subscription.destroy()
		client2Subscription.destroy()
	})

	test("replays a later local mutation while pulling between queued pushes", async ({
		gatekeeper,
	}) => {
		const { client1, client2 } = gatekeeper
		const client1Subscription = client1.subscribe({ collection: "todos" })
		const client2Subscription = client2.subscribe({ collection: "todos" })
		const seedTx = client1.transact()
		seedTx.set("todos", todo("todo-1", { text: "First original" }))
		seedTx.set("todos", todo("todo-2", { text: "Second original" }))
		await (
			await client1.commit(seedTx)
		).result
		await expectQuery(client2, { collection: "todos" }).toResolveTo([
			todo("todo-1", { text: "First original" }),
			todo("todo-2", { text: "Second original" }),
		])
		await gatekeeper.activateGates()

		// Hold client2's first push while client1 advances the same server record
		const firstLocalTx = client2.transact()
		firstLocalTx.set("todos", todo("todo-1", { text: "First local edit" }))
		const firstLocalCommit = await client2.commit(firstLocalTx)
		const remoteTx = client1.transact()
		remoteTx.set("todos", todo("todo-1", { text: "Remote edit" }))
		const remoteCommit = await client1.commit(remoteTx)
		await remoteCommit.continueToCompletion()

		// A second local mutation queues behind the pull triggered by the remote edit
		const secondLocalTx = client2.transact()
		secondLocalTx.set("todos", todo("todo-2", { text: "Second local edit" }))
		const secondLocalReady = client2.commit(secondLocalTx)
		await firstLocalCommit.continueToCompletion()
		const secondLocalCommit = await secondLocalReady

		expect(client2.query({ collection: "todos" })).toEqual([
			todo("todo-1", { text: "First local edit" }),
			todo("todo-2", { text: "Second local edit" }),
		])

		await secondLocalCommit.continueToCompletion()
		const client1Pull = await client1.pullFromRemote()
		await client1Pull.continueToCompletion()
		const client2Pull = await client2.pullFromRemote()
		await client2Pull.continueToCompletion()

		const canonicalTodos = [
			todo("todo-1", { text: "First local edit" }),
			todo("todo-2", { text: "Second local edit" }),
		]
		expect(client1.query({ collection: "todos" })).toEqual(canonicalTodos)
		expect(client2.query({ collection: "todos" })).toEqual(canonicalTodos)
		client1Subscription.destroy()
		client2Subscription.destroy()
	})

	test("converges when a concurrent removal follows an update", async ({
		gatekeeper,
	}) => {
		const { client1, client2 } = gatekeeper
		const client1Subscription = client1.subscribe({ collection: "todos" })
		const client2Subscription = client2.subscribe({ collection: "todos" })
		const seedTx = client1.transact()
		seedTx.set("todos", todo("shared", { text: "Original" }))
		await (
			await client1.commit(seedTx)
		).result
		await expectQuery(client2, { collection: "todos" }).toResolveTo([
			todo("shared", { text: "Original" }),
		])
		await gatekeeper.activateGates()

		// Client1 updates while client2 removes the same record
		const updateTx = client1.transact()
		updateTx.set("todos", todo("shared", { text: "Updated" }))
		const update = await client1.commit(updateTx)
		const removeTx = client2.transact()
		removeTx.remove("todos", "shared")
		const remove = await client2.commit(removeTx)

		// Applying the removal last leaves every replica empty
		await update.continueToCompletion()
		await remove.continueToCompletion()
		const client1Pull = await client1.pullFromRemote()
		await client1Pull.continueToCompletion()
		const client2Pull = await client2.pullFromRemote()
		await client2Pull.continueToCompletion()

		expect(client1.query({ collection: "todos" })).toEqual([])
		expect(client2.query({ collection: "todos" })).toEqual([])
		client1Subscription.destroy()
		client2Subscription.destroy()
	})

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
})
