import { Gatekeeper } from "@tanishqkancharla/gatekeeper"
import { TandemClient } from "@tanishqkancharla/tandem-core"
import { describe, expect } from "vitest"
import { test, testsRuntimeSchema, todo, type TestsTodo } from "./fixtures.js"

describe("TandemClient local data", () => {
	test("creates, queries, updates, and deletes records locally", async ({
		gatekeeper,
	}) => {
		const { client1 } = gatekeeper
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
		await (
			await client1.commit(tx)
		).result

		const highestPriorityOpenTodoSummaries = client1.query({
			collection: "todos",
			where: { done: false },
			orderBy: { priority: "desc" },
			limit: 2,
			select: { id: true, text: true },
		})

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
		await (
			await client1.commit(updateTx)
		).result

		const remainingOpenTodos = client1.query({
			collection: "todos",
			where: { done: false },
			orderBy: { priority: "desc" },
		})
		const deletedTodo = client1.query({
			collection: "todos",
			where: { id: "todo-2" },
			limit: 1,
		})

		expect(remainingOpenTodos).toEqual([
			todo("todo-3", { text: "Fix the sync bug", priority: 3 }),
		])
		expect(deletedTodo).toEqual([])
	})

	test("runs flat queries unchanged when constructed with a runtime schema", async ({
		logger,
		rng,
	}) => {
		await using gatekeeper = new Gatekeeper()
			.add(
				"client",
				() =>
					new TandemClient({
						logger,
						rng: rng.create("schema-client"),
						schema: testsRuntimeSchema,
					}),
			)
			.build()
		const client = gatekeeper.client
		await client.ready

		// Seed records through the normal flat transaction API
		const tx = client.transact()
		tx.set(
			"todos",
			todo("todo-1", { text: "Write the sync spec", priority: 2 }),
		)
		tx.set(
			"todos",
			todo("todo-2", { text: "Ship the docs", done: true, priority: 1 }),
		)
		tx.set("todos", todo("todo-3", { text: "Fix the sync bug", priority: 3 }))
		await (
			await client.commit(tx)
		).result

		// Object queries produce the same projected results
		const highestPriorityOpenTodoSummaries = client.query({
			collection: "todos",
			where: { done: false },
			orderBy: { priority: "desc" },
			limit: 2,
			select: { id: true, text: true },
		})

		expect(highestPriorityOpenTodoSummaries).toEqual([
			{ id: "todo-3", text: "Fix the sync bug" },
			{ id: "todo-1", text: "Write the sync spec" },
		])
	})

	test("keeps subscribed query results live until the caller unsubscribes", async ({
		gatekeeper,
	}) => {
		const { client1 } = gatekeeper
		const seedTx = client1.transact()
		seedTx.set(
			"todos",
			todo("todo-1", { text: "Write the sync spec", priority: 2 }),
		)
		seedTx.set(
			"todos",
			todo("todo-2", { text: "Ship the docs", done: true, priority: 1 }),
		)
		await (
			await client1.commit(seedTx)
		).result

		let latestResult: TestsTodo[] | undefined
		const subscription = client1.subscribe(
			{
				collection: "todos",
				where: { done: false },
				orderBy: { priority: "desc" },
			},
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
		await (
			await client1.commit(addOpenTodoTx)
		).result

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
		await (
			await client1.commit(completeOpenTodoTx)
		).result

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
		await (
			await client1.commit(anotherOpenTodoTx)
		).result

		expect(latestResult).toBeUndefined()
	})

	test("lets a caller inspect draft changes and cancel them before commit", async ({
		gatekeeper,
	}) => {
		const { client1 } = gatekeeper
		// Draft changes are visible on the transaction but not on the client
		const draftTx = client1.transact()
		draftTx.set(
			"todos",
			todo("todo-1", { text: "Write the sync spec", priority: 2 }),
		)

		const draftTodo = draftTx.get("todos", "todo-1")
		const draftTodoList = draftTx.list("todos")
		const todosBeforeCommit = client1.query({ collection: "todos" })

		expect(draftTodo).toEqual(
			todo("todo-1", { text: "Write the sync spec", priority: 2 }),
		)
		expect(draftTodoList).toEqual([
			todo("todo-1", { text: "Write the sync spec", priority: 2 }),
		])
		expect(todosBeforeCommit).toEqual([])

		// Cancelling discards the draft; the database stays empty
		draftTx.cancel()

		const todosAfterCancel = client1.query({ collection: "todos" })

		expect(todosAfterCancel).toEqual([])

		// Committing operations against missing records is a harmless no-op
		const noopTx = client1.transact()
		noopTx.update("todos", "missing", (record) => ({ ...record, done: true }))
		noopTx.remove("todos", "missing")
		await (
			await client1.commit(noopTx)
		).result

		const todosAfterNoopCommit = client1.query({ collection: "todos" })

		expect(todosAfterNoopCommit).toEqual([])
	})
})
