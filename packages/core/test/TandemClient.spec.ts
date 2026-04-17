import { describe, expect, vi } from "vitest"
import { test, TestsSchema, todo, type TestsTodo } from "./fixtures"
import { RemoteApi } from "@tandem/types"

describe("TandemClient", () => {
	test("creates, queries, updates, and deletes records locally", async ({
		client1,
	}) => {
		// Seed three todos and query the highest-priority open ones
		const tx = client1.transact()
		tx.set(
			"todos",
			todo("todo-1", { text: "Write the sync spec", priority: 2 }),
		)
		tx.set(
			"todos",
			todo("todo-2", { text: "Ship the docs", done: true, priority: 1 }),
		)
		tx.set("todos", todo("todo-3", { text: "Fix the sync bug", priority: 3 }))
		await client1.commit(tx)

		const highestPriorityOpenTodoSummaries = client1.run("todos", (q) =>
			q
				.where("done", "=", false)
				.order("priority", "desc")
				.limit(2)
				.select(["id", "text"]),
		)

		expect(highestPriorityOpenTodoSummaries).toEqual([
			{ id: "todo-3", text: "Fix the sync bug" },
			{ id: "todo-1", text: "Write the sync spec" },
		])

		// Updating and removing records is reflected in subsequent queries
		const updateTx = client1.transact()
		updateTx.update("todos", "todo-1", (record) => ({
			...record,
			done: true,
			priority: 5,
		}))
		updateTx.remove("todos", "todo-2")
		await client1.commit(updateTx)

		const remainingOpenTodos = client1.run("todos", (q) =>
			q.where("done", "=", false).order("priority", "desc"),
		)
		const deletedTodo = client1.run("todos", (q) => q.id("todo-2"))

		expect(remainingOpenTodos).toEqual([
			todo("todo-3", { text: "Fix the sync bug", priority: 3 }),
		])
		expect(deletedTodo).toEqual([])
	})

	test("keeps subscribed query results live until the caller unsubscribes", async ({
		client1,
	}) => {
		const seedTx = client1.transact()
		seedTx.set(
			"todos",
			todo("todo-1", { text: "Write the sync spec", priority: 2 }),
		)
		seedTx.set(
			"todos",
			todo("todo-2", { text: "Ship the docs", done: true, priority: 1 }),
		)
		await client1.commit(seedTx)

		let latestResult: TestsTodo[] | undefined
		const subscription = client1.subscribe(
			"todos",
			(q) => q.where("done", "=", false).order("priority", "desc"),
			(result) => {
				latestResult = result
			},
		)

		// Initial subscription result is available synchronously; callback hasn't fired yet
		expect(subscription.result).toEqual([
			todo("todo-1", { text: "Write the sync spec", priority: 2 }),
		])
		expect(latestResult).toBeUndefined()

		// Adding a matching record triggers the callback with the updated result
		const addOpenTodoTx = client1.transact()
		addOpenTodoTx.set(
			"todos",
			todo("todo-3", { text: "Fix the sync bug", priority: 3 }),
		)
		await client1.commit(addOpenTodoTx)

		expect(latestResult).toEqual([
			todo("todo-3", { text: "Fix the sync bug", priority: 3 }),
			todo("todo-1", { text: "Write the sync spec", priority: 2 }),
		])

		// Completing a todo removes it from the open-only subscription
		const completeOpenTodoTx = client1.transact()
		completeOpenTodoTx.update("todos", "todo-1", (record) => ({
			...record,
			done: true,
		}))
		await client1.commit(completeOpenTodoTx)

		expect(latestResult).toEqual([
			todo("todo-3", { text: "Fix the sync bug", priority: 3 }),
		])

		// After unsubscribing, further commits don't trigger the callback
		subscription.destroy()
		latestResult = undefined

		const anotherOpenTodoTx = client1.transact()
		anotherOpenTodoTx.set(
			"todos",
			todo("todo-4", { text: "This update should stay quiet", priority: 4 }),
		)
		await client1.commit(anotherOpenTodoTx)

		expect(latestResult).toBeUndefined()
	})

	test("lets a caller inspect draft changes and cancel them before commit", async ({
		client1,
	}) => {
		// Draft changes are visible on the transaction but not on the client
		const draftTx = client1.transact()
		draftTx.set(
			"todos",
			todo("todo-1", { text: "Write the sync spec", priority: 2 }),
		)

		const draftTodo = draftTx.get("todos", "todo-1")
		const draftTodoList = draftTx.list("todos")
		const todosBeforeCommit = client1.run("todos", (q) => q)

		expect(draftTodo).toEqual(
			todo("todo-1", { text: "Write the sync spec", priority: 2 }),
		)
		expect(draftTodoList).toEqual([
			todo("todo-1", { text: "Write the sync spec", priority: 2 }),
		])
		expect(todosBeforeCommit).toEqual([])

		// Cancelling discards the draft; the database stays empty
		draftTx.cancel()

		const todosAfterCancel = client1.run("todos", (q) => q)

		expect(todosAfterCancel).toEqual([])

		// Committing operations against missing records is a harmless no-op
		const noopTx = client1.transact()
		noopTx.update("todos", "missing", (record) => ({ ...record, done: true }))
		noopTx.remove("todos", "missing")
		await client1.commit(noopTx)

		const todosAfterNoopCommit = client1.run("todos", (q) => q)

		expect(todosAfterNoopCommit).toEqual([])
	})

	test("syncs a committed change from one client to another subscribed client", async ({
		client1,
		client2,
	}) => {
		const seenByClient2: TestsTodo[][] = []
		client2.subscribe(
			"todos",
			(q) => q,
			(result) => {
				seenByClient2.push(result)
			},
		)

		// A commit on client1 is synced to client2's subscription
		const tx = client1.transact()
		tx.set(
			"todos",
			todo("todo-1", { text: "Write the sync spec", priority: 2 }),
		)
		await client1.commit(tx)

		await vi.waitFor(() => {
			expect(seenByClient2).toEqual([
				[todo("todo-1", { text: "Write the sync spec", priority: 2 })],
			])
		})

		// The synced record is also queryable directly on client2
		const syncedTodoOnClient2 = client2.run("todos", (q) => q.id("todo-1"))

		expect(syncedTodoOnClient2).toEqual([
			todo("todo-1", { text: "Write the sync spec", priority: 2 }),
		])
	})

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
		client.subscribe(
			"todos",
			(q) => q,
			(result) => {
				latestResult = result
			},
		)

		await client.connect()

		// The optimistic write is visible immediately before the push resolves
		const tx = client.transact()
		tx.set("todos", offlineDraft)

		const commit = client.commit(tx)
		const optimisticTodoList = client.run("todos", (q) => q)

		expect(optimisticTodoList).toEqual([offlineDraft])
		expect(latestResult).toEqual([offlineDraft])

		// After the push fails, the optimistic write is rolled back
		await expect(commit).rejects.toThrow("offline")

		const todosAfterRollback = client.run("todos", (q) => q)

		expect(latestResult).toEqual([])
		expect(todosAfterRollback).toEqual([])
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

		client1.subscribe(
			"todos",
			(q) => q,
			() => {},
		)
		client2.subscribe(
			"todos",
			(q) => q,
			() => {},
		)

		await Promise.all([client1.connect(), client2.connect()])

		// Seed a todo on client1 and wait for it to sync to client2
		const seedTx = client1.transact()
		seedTx.set(
			"todos",
			todo("todo-1", { text: "Write the sync spec", priority: 2 }),
		)
		await client1.commit(seedTx)

		await vi.waitFor(() => {
			const syncedSeedTodoOnClient2 = client2.run("todos", (q) =>
				q.id("todo-1"),
			)

			expect(syncedSeedTodoOnClient2).toEqual([
				todo("todo-1", { text: "Write the sync spec", priority: 2 }),
			])
		})

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
		await vi.waitFor(() => {
			const rebasedTodoOnClient2 = client2.run("todos", (q) => q.id("todo-1"))

			expect(rebasedTodoOnClient2).toEqual([
				todo("todo-1", { text: "Local edit on client 2", priority: 2 }),
			])
		})

		// Once the gate opens, client2's push lands and client1 converges
		gate.resolve()
		await pendingCommit

		await vi.waitFor(() => {
			const finalTodoOnClient1 = client1.run("todos", (q) => q.id("todo-1"))

			expect(finalTodoOnClient1).toEqual([
				todo("todo-1", { text: "Local edit on client 2", priority: 2 }),
			])
		})
	})

	test("reloads persisted records after recreating the app", async ({
		makeClient,
	}) => {
		// Commit records with the first client
		const firstClient = await makeClient({
			label: "persistent-client-1",
			remote: false,
			storageDbName: "persisted-todos",
		})

		const tx = firstClient.transact()
		tx.set(
			"todos",
			todo("todo-1", { text: "Write the sync spec", priority: 2 }),
		)
		tx.set("todos", todo("todo-3", { text: "Fix the sync bug", priority: 3 }))
		await firstClient.commit(tx)
		await firstClient.flushStorage()

		// A new client backed by the same storage sees the persisted records
		const secondClient = await makeClient({
			label: "persistent-client-2",
			remote: false,
			storageDbName: "persisted-todos",
		})

		const persistedTodosOnReload = secondClient.run("todos", (q) =>
			q.order("priority", "asc"),
		)

		expect(persistedTodosOnReload).toEqual([
			todo("todo-1", { text: "Write the sync spec", priority: 2 }),
			todo("todo-3", { text: "Fix the sync bug", priority: 3 }),
		])
	})
})
