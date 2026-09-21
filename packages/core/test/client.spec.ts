import { describe, expect } from "vitest"
import { test, testsRuntimeSchema, todo, type TestsTodo } from "./fixtures"

describe("TandemClient local data", () => {
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
		await client1.commit(updateTx)

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
		makeClient,
	}) => {
		const client = await makeClient({
			label: "schema-client",
			remote: false,
			schema: testsRuntimeSchema,
		})

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
		await client.commit(tx)

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

	test("runs relational object queries locally", async ({
		threadClient: client,
	}) => {
		// Seed users, threads, and messages related by many-to-one and one-to-many joins
		const tx = client.transact()
		tx.set("profiles", { id: "profile-1", displayName: "Ada Lovelace" })
		tx.set("profiles", { id: "profile-2", displayName: "Grace Hopper" })
		tx.set("users", { id: "user-1", profileId: "profile-1", name: "Ada" })
		tx.set("users", { id: "user-2", profileId: "profile-2", name: "Grace" })
		tx.set("threads", {
			id: "thread-1",
			ownerId: "user-1",
			title: "Active thread",
			status: "active",
		})
		tx.set("threads", {
			id: "thread-2",
			ownerId: "missing-user",
			title: "Archived thread",
			status: "archived",
		})
		tx.set("messages", {
			id: "message-1",
			threadId: "thread-1",
			body: "Older message",
			createdAt: 1,
		})
		tx.set("messages", {
			id: "message-2",
			threadId: "thread-1",
			body: "Newest message",
			createdAt: 2,
		})
		await client.commit(tx)

		// Query options filter/project parent rows while included relations resolve from omitted join fields
		const activeThreads = client.query({
			collection: "threads",
			select: { id: true, title: true },
			where: { status: "active" },
			with: {
				owner: { select: { name: true } },
				messages: {
					select: { body: true },
					orderBy: { createdAt: "desc" },
					limit: 1,
				},
			},
		})

		expect(activeThreads).toEqual([
			{
				id: "thread-1",
				title: "Active thread",
				owner: { name: "Ada" },
				messages: [{ body: "Newest message" }],
			},
		])

		// Missing many-to-one targets are returned as null, not arrays or omitted keys
		const archivedThreads = client.query({
			collection: "threads",
			select: { id: true },
			where: { status: "archived" },
			with: { owner: { select: { name: true } } },
		})

		expect(archivedThreads).toEqual([{ id: "thread-2", owner: null }])
	})

	test("keeps relational object subscriptions live", async ({
		threadClient: client,
	}) => {
		// Seed a thread with a many-to-one owner, nested profile, and one-to-many messages
		const seedTx = client.transact()
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
			body: "First message",
			createdAt: 1,
		})
		await client.commit(seedTx)

		let latestResult:
			| {
					id: string
					owner: {
						name: string
						profile: { displayName: string } | null
					} | null
					messages: { body: string }[]
			  }[]
			| undefined

		const subscription = client.subscribe(
			{
				collection: "threads",
				select: { id: true },
				with: {
					owner: {
						select: { name: true },
						with: { profile: { select: { displayName: true } } },
					},
					messages: {
						select: { body: true },
						orderBy: { createdAt: "asc" },
					},
				},
			},
			(result) => {
				latestResult = result
			},
		)

		// Initial relational subscription result is available synchronously
		expect(subscription.result).toEqual([
			{
				id: "thread-1",
				owner: {
					name: "Ada",
					profile: { displayName: "Ada Lovelace" },
				},
				messages: [{ body: "First message" }],
			},
		])
		expect(latestResult).toBeUndefined()

		// Updating an included child re-emits the parent row with updated embedded results
		const addMessageTx = client.transact()
		addMessageTx.set("messages", {
			id: "message-2",
			threadId: "thread-1",
			body: "Second message",
			createdAt: 2,
		})
		await client.commit(addMessageTx)

		expect(latestResult).toEqual([
			{
				id: "thread-1",
				owner: {
					name: "Ada",
					profile: { displayName: "Ada Lovelace" },
				},
				messages: [{ body: "First message" }, { body: "Second message" }],
			},
		])

		// Updating a nested included relation also re-emits the parent row
		const updateProfileTx = client.transact()
		updateProfileTx.update("profiles", "profile-1", (profile) => ({
			...profile,
			displayName: "Countess Lovelace",
		}))
		await client.commit(updateProfileTx)

		expect(latestResult).toEqual([
			{
				id: "thread-1",
				owner: {
					name: "Ada",
					profile: { displayName: "Countess Lovelace" },
				},
				messages: [{ body: "First message" }, { body: "Second message" }],
			},
		])

		// After unsubscribing, further child changes don't trigger the callback
		subscription.destroy()
		latestResult = undefined

		const quietMessageTx = client.transact()
		quietMessageTx.set("messages", {
			id: "message-3",
			threadId: "thread-1",
			body: "Quiet message",
			createdAt: 3,
		})
		await client.commit(quietMessageTx)

		expect(latestResult).toBeUndefined()
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
		await client1.commit(noopTx)

		const todosAfterNoopCommit = client1.query({ collection: "todos" })

		expect(todosAfterNoopCommit).toEqual([])
	})
})
