import type { RemoteApi } from "@tanishqkancharla/tandem-core"
import { describe, expect, vi } from "vitest"
import {
	expectQuery,
	test,
	type TestsSchema,
	threadTestRelations,
	threadTestSchema,
	todo,
	type TestsTodo,
	type ThreadTestSchema,
} from "./fixtures"

describe("TandemClient sync conflicts", () => {
	test("rolls back an optimistic write when the server rejects the push", async ({
		makeClient,
	}) => {
		const client = await makeClient({
			label: "offline-client",
			remote: {
				connect: () => Promise.resolve(async () => {}),
				pull: () => Promise.resolve({ cookie: 0 as any, patch: {} }),
				push: () => Promise.reject(new Error("offline")),
			},
		})

		const offlineDraft = todo("offline-todo", {
			text: "Write while offline",
			priority: 1,
		})

		let latestResult: TestsTodo[] | undefined
		client.subscribe({ collection: "todos" }, (result) => {
			latestResult = result
		})

		await client.connect()

		// The optimistic write is visible immediately before the push resolves
		const tx = client.transact()
		tx.set("todos", offlineDraft)

		const commit = client.commit(tx)
		const optimisticTodoList = client.query({ collection: "todos" })

		expect(optimisticTodoList).toEqual([offlineDraft])
		expect(latestResult).toEqual([offlineDraft])

		// After the push fails, the optimistic write is rolled back
		await expect(commit).rejects.toThrow("offline")

		const todosAfterRollback = client.query({ collection: "todos" })

		expect(latestResult).toEqual([])
		expect(todosAfterRollback).toEqual([])
	})

	test("keeps pending mutations queued while disconnected and pushes them after reconnect", async ({
		makeClient,
		server,
	}) => {
		const pushedMutationCounts: number[] = []
		const remote: RemoteApi<TestsSchema> = {
			connect: (client) => server.connect(client),
			pull: (args) => server.pull(args),
			push: (args) => {
				pushedMutationCounts.push(args.mutations.length)
				return server.push(args)
			},
		}
		const client = await makeClient({
			label: "reconnect-push-client",
			remote,
			autoConnect: false,
		})

		// Committing while disconnected does not call remote push
		const tx = client.transact()
		tx.set("todos", todo("todo-1", { text: "Write while disconnected" }))
		await client.commit(tx)

		expect(pushedMutationCounts).toEqual([])

		// Connecting later flushes the pending mutation
		await client.connect()

		expect(pushedMutationCounts).toEqual([1])
	})

	test("replays a pending local edit on top of a newer remote patch", async ({
		makeClient,
		server,
	}) => {
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

		const client1 = await makeClient({
			label: "client1",
			remote: delayedServer,
		})
		const client2 = await makeClient({
			label: "client2",
			remote: delayedServer,
		})
		delayedClientId = client2.clientId

		client1.subscribe({ collection: "todos" })
		client2.subscribe({ collection: "todos" })

		await Promise.all([client1.connect(), client2.connect()])

		// Seed a todo on client1 and wait for it to sync to client2
		const seedTx = client1.transact()
		seedTx.set(
			"todos",
			todo("todo-1", { text: "Write the sync spec", priority: 2 }),
		)
		await client1.commit(seedTx)

		await expectQuery(client2, {
			collection: "todos",
			where: { id: "todo-1" },
			limit: 1,
		}).toResolveTo([
			todo("todo-1", { text: "Write the sync spec", priority: 2 }),
		])

		// Client2 edits the todo; its push is held by the gate
		const localEditTx = client2.transact()
		localEditTx.set(
			"todos",
			todo("todo-1", { text: "Local edit on client 2", priority: 2 }),
		)
		const pendingCommit = client2.commit(localEditTx)

		await vi.waitFor(() => {
			expect(delayedPushStarted).toBe(true)
		})

		// While client2's push is in-flight, client1 lands a competing edit
		const remoteEditTx = client1.transact()
		remoteEditTx.set(
			"todos",
			todo("todo-1", {
				text: "Remote edit on client 1",
				done: true,
				priority: 5,
			}),
		)
		await client1.commit(remoteEditTx)

		// Client2 rebases its pending edit on top of the remote patch
		await expectQuery(client2, {
			collection: "todos",
			where: { id: "todo-1" },
			limit: 1,
		}).toResolveTo([
			todo("todo-1", { text: "Local edit on client 2", priority: 2 }),
		])

		// Once the gate opens, client2's push lands and client1 converges
		gate.resolve()
		await pendingCommit

		await expectQuery(client1, {
			collection: "todos",
			where: { id: "todo-1" },
			limit: 1,
		}).toResolveTo([
			todo("todo-1", { text: "Local edit on client 2", priority: 2 }),
		])
	})

	test("replays a pending included relation edit on top of a newer remote patch", async ({
		makeClient,
		makeRemote,
	}) => {
		const server = makeRemote({
			schema: threadTestSchema,
			relations: threadTestRelations,
		})
		const gate = Promise.withResolvers<void>()
		let delayedClientId = ""
		let delayedPushStarted = false
		const delayedServer: RemoteApi<ThreadTestSchema> = {
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
		const client1 = await makeClient.withSchema({
			label: "relational-replay-client1",
			schema: threadTestSchema,
			relations: threadTestRelations,
			remote: delayedServer,
		})
		const client2 = await makeClient.withSchema({
			label: "relational-replay-client2",
			schema: threadTestSchema,
			relations: threadTestRelations,
			remote: delayedServer,
		})
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

		await Promise.all([client1.connect(), client2.connect()])

		const seenByClient2: { id: string; messages: { body: string }[] }[][] = []
		client1.subscribe(threadWithMessagesQuery)
		client2.subscribe(threadWithMessagesQuery, (result) => {
			seenByClient2.push(result)
		})

		// Seed a thread and included message on client1 and wait for client2 to sync them
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
		await client1.commit(seedTx)

		await expectQuery(client2, threadWithMessagesQuery).toResolveTo([
			{ id: "thread-1", messages: [{ body: "Original message" }] },
		])

		// Client2 edits the included child record while its push is held by the gate
		const localEditTx = client2.transact()
		localEditTx.set("messages", {
			id: "message-1",
			threadId: "thread-1",
			body: "Local included edit",
			createdAt: 1,
		})
		const pendingCommit = client2.commit(localEditTx)

		await vi.waitFor(() => {
			expect(delayedPushStarted).toBe(true)
		})

		// A newer remote patch lands for the same included child record
		const remoteEditTx = client1.transact()
		remoteEditTx.set("messages", {
			id: "message-1",
			threadId: "thread-1",
			body: "Remote included edit",
			createdAt: 1,
		})
		await client1.commit(remoteEditTx)

		const expectedRebasedRows = [
			{ id: "thread-1", messages: [{ body: "Local included edit" }] },
		]

		// Client2 rolls back, applies the remote included record, and replays its local included edit
		await expectQuery(client2, threadWithMessagesQuery).toResolveTo(
			expectedRebasedRows,
		)
		expect(seenByClient2.at(-1)).toEqual(expectedRebasedRows)

		// Once the gate opens, client2's included edit lands and client1 converges
		gate.resolve()
		await pendingCommit

		await expectQuery(client1, threadWithMessagesQuery).toResolveTo(
			expectedRebasedRows,
		)
	})
})
