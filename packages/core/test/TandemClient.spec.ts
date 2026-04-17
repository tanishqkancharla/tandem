import { describe, expect, vi } from "vitest"
import { test, demoTodos, todo, type DemoTodo } from "./fixtures"

describe("TandemClient", () => {
	test("creates, queries, updates, and deletes records locally", async ({ client1 }) => {
		const tx = client1.transact()
		tx.set("todos", demoTodos.writeSpec)
		tx.set("todos", demoTodos.shipDocs)
		tx.set("todos", demoTodos.fixSync)
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

		const update = client1.transact()
		update.update("todos", "todo-1", (record) => ({
			...record,
			done: true,
			priority: 5,
		}))
		update.remove("todos", "todo-2")
		await client1.commit(update)

		const remainingOpenTodos = client1.run("todos", (q) =>
			q.where("done", "=", false).order("priority", "desc"),
		)
		const deletedTodo = client1.run("todos", (q) => q.id("todo-2"))

		expect(remainingOpenTodos).toEqual([demoTodos.fixSync])
		expect(deletedTodo).toEqual([])
	})

	test("keeps subscribed query results live until the caller unsubscribes", async ({ client1 }) => {
		const seed = client1.transact()
		seed.set("todos", demoTodos.writeSpec)
		seed.set("todos", demoTodos.shipDocs)
		await client1.commit(seed)

		const seen: DemoTodo[][] = []
		const subscription = client1.subscribe(
			"todos",
			(q) => q.where("done", "=", false).order("priority", "desc"),
			(result) => {
				seen.push(result)
			},
		)

		const initialSubscriptionResult = subscription.result

		expect(initialSubscriptionResult).toEqual([demoTodos.writeSpec])
		expect(seen).toEqual([])

		const addOpenTodo = client1.transact()
		addOpenTodo.set("todos", demoTodos.fixSync)
		await client1.commit(addOpenTodo)

		const completeOpenTodo = client1.transact()
		completeOpenTodo.update("todos", "todo-1", (record) => ({
			...record,
			done: true,
		}))
		await client1.commit(completeOpenTodo)

		expect(seen).toEqual([
			[demoTodos.fixSync, demoTodos.writeSpec],
			[demoTodos.fixSync],
		])

		subscription.destroy()

		const anotherOpenTodo = client1.transact()
		anotherOpenTodo.set(
			"todos",
			todo("todo-4", { text: "This update should stay quiet", priority: 4 }),
		)
		await client1.commit(anotherOpenTodo)

		expect(seen).toEqual([
			[demoTodos.fixSync, demoTodos.writeSpec],
			[demoTodos.fixSync],
		])
	})

	test("lets a caller inspect draft changes and cancel them before commit", async ({ client1 }) => {
		const draft = client1.transact()
		draft.set("todos", demoTodos.writeSpec)

		const draftTodo = draft.get("todos", "todo-1")
		const draftTodoList = draft.list("todos")
		const todosBeforeCommit = client1.run("todos", (q) => q)

		expect(draftTodo).toEqual(demoTodos.writeSpec)
		expect(draftTodoList).toEqual([demoTodos.writeSpec])
		expect(todosBeforeCommit).toEqual([])

		draft.cancel()

		const todosAfterCancel = client1.run("todos", (q) => q)

		expect(todosAfterCancel).toEqual([])

		const noop = client1.transact()
		noop.update("todos", "missing", (record) => ({ ...record, done: true }))
		noop.remove("todos", "missing")
		await client1.commit(noop)

		const todosAfterNoopCommit = client1.run("todos", (q) => q)

		expect(todosAfterNoopCommit).toEqual([])
	})

	test("syncs a committed change from one client to another subscribed client", async ({ makeClient, server }) => {
		const client1 = await makeClient({ label: "client1", remote: server })
		const client2 = await makeClient({ label: "client2", remote: server })

		const seenByClient2: DemoTodo[][] = []
		client2.subscribe("todos", (q) => q, (result) => {
			seenByClient2.push(result)
		})

		await Promise.all([client1.connect(), client2.connect()])

		const tx = client1.transact()
		tx.set("todos", demoTodos.writeSpec)
		await client1.commit(tx)

		await vi.waitFor(() => {
			const todosSeenByClient2 = seenByClient2

			expect(todosSeenByClient2).toEqual([[demoTodos.writeSpec]])
		})

		const syncedTodoOnClient2 = client2.run("todos", (q) => q.id("todo-1"))

		expect(syncedTodoOnClient2).toEqual([demoTodos.writeSpec])
	})

	test("rolls back an optimistic write when the server rejects the push", async ({ makeClient }) => {
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

		const seen: DemoTodo[][] = []
		client.subscribe("todos", (q) => q, (result) => {
			seen.push(result)
		})

		await client.connect()

		const tx = client.transact()
		tx.set("todos", offlineDraft)

		const commit = client.commit(tx)
		const optimisticTodoList = client.run("todos", (q) => q)

		expect(optimisticTodoList).toEqual([offlineDraft])

		await expect(commit).rejects.toThrow("offline")

		const todosAfterRollback = client.run("todos", (q) => q)

		expect(seen).toEqual([[offlineDraft], []])
		expect(todosAfterRollback).toEqual([])
	})

	test("replays a pending local edit on top of a newer remote patch", async ({ makeClient, server }) => {
		const gate = Promise.withResolvers<void>()
		let delayedClientId = ""
		let delayedPushStarted = false

		const delayedServer = {
			connect: (args: Parameters<typeof server.connect>[0]) => server.connect(args),
			pull: (args: Parameters<typeof server.pull>[0]) => server.pull(args),
			push: async (args: Parameters<typeof server.push>[0]) => {
				if (args.clientId === delayedClientId) {
					delayedPushStarted = true
					await gate.promise
				}

				return server.push(args)
			},
		}

		const client1 = await makeClient({ label: "client1", remote: delayedServer })
		const client2 = await makeClient({ label: "client2", remote: delayedServer })
		delayedClientId = client2.clientId

		client1.subscribe("todos", (q) => q, () => {})
		client2.subscribe("todos", (q) => q, () => {})

		await Promise.all([client1.connect(), client2.connect()])

		const seed = client1.transact()
		seed.set("todos", demoTodos.writeSpec)
		await client1.commit(seed)

		await vi.waitFor(() => {
			const syncedSeedTodoOnClient2 = client2.run("todos", (q) =>
				q.id("todo-1"),
			)

			expect(syncedSeedTodoOnClient2).toEqual([demoTodos.writeSpec])
		})

		const localEdit = client2.transact()
		localEdit.set(
			"todos",
			todo("todo-1", { text: "Local edit on client 2", priority: 2 }),
		)
		const pendingCommit = client2.commit(localEdit)

		await vi.waitFor(() => {
			const delayedPushHasStarted = delayedPushStarted

			expect(delayedPushHasStarted).toBe(true)
		})

		const remoteEdit = client1.transact()
		remoteEdit.set(
			"todos",
			todo("todo-1", {
				text: "Remote edit on client 1",
				done: true,
				priority: 5,
			}),
		)
		await client1.commit(remoteEdit)

		await vi.waitFor(() => {
			const rebasedTodoOnClient2 = client2.run("todos", (q) => q.id("todo-1"))

			expect(rebasedTodoOnClient2).toEqual([
				todo("todo-1", { text: "Local edit on client 2", priority: 2 }),
			])
		})

		gate.resolve()
		await pendingCommit

		await vi.waitFor(() => {
			const finalTodoOnClient1 = client1.run("todos", (q) => q.id("todo-1"))

			expect(finalTodoOnClient1).toEqual([
				todo("todo-1", { text: "Local edit on client 2", priority: 2 }),
			])
		})
	})

	test("reloads persisted records after recreating the app", async ({ makeClient, rng }) => {
		const dbName = rng.next("indexeddb")
		const firstClient = await makeClient({
			label: "persistent-client-1",
			remote: false,
			storageDbName: dbName,
		})

		const tx = firstClient.transact()
		tx.set("todos", demoTodos.writeSpec)
		tx.set("todos", demoTodos.fixSync)
		await firstClient.commit(tx)

		await new Promise((resolve) => setTimeout(resolve, 200))

		const secondClient = await makeClient({
			label: "persistent-client-2",
			remote: false,
			storageDbName: dbName,
		})

		const persistedTodosOnReload = secondClient.run("todos", (q) =>
			q.order("priority", "asc"),
		)

		expect(persistedTodosOnReload).toEqual([
			demoTodos.writeSpec,
			demoTodos.fixSync,
		])
	})
})
