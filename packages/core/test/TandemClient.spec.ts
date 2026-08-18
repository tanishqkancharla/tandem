import { describe, expect, vi } from "vitest"
import {
	expectQuery,
	test,
	TestsSchema,
	threadTestRelations,
	threadTestSchema,
	testsRuntimeSchema,
	todo,
	type TestsTodo,
	type ThreadTestSchema,
} from "./fixtures"
import type { RemoteApi } from "@tandem/types"
import { collection, defineSchema } from "../src/schema/Schema"
import { codec } from "../src/utils/Codec"

class EventStart {
	constructor(readonly iso: string) {}
}

type TestsEvent = {
	id: string
	title: string
	startAt: EventStart
}

type TestsEventStorageValue = {
	id: string
	title: string
	startAt: string
}

type TestsEventSchema = {
	events: TestsEvent
}

const eventCodec = codec<TestsEvent, TestsEventStorageValue>(
	"event",
	(input) => {
		const event = input as TestsEvent
		return {
			...event,
			startAt: event.startAt.iso,
		}
	},
	(input) => {
		const event = input as TestsEventStorageValue
		return {
			...event,
			startAt: new EventStart(event.startAt),
		}
	},
)

const testsEventRuntimeSchema = defineSchema({
	events: collection<TestsEvent, TestsEventStorageValue>({
		fields: ["id", "title", "startAt"],
		codec: eventCodec,
	}),
})

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

	test("syncs a committed change from one client to another subscribed client", async ({
		client1,
		client2,
	}) => {
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
		await client1.commit(tx)

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

	test("syncs flat subscription updates unchanged when constructed with a runtime schema", async ({
		makeClient,
	}) => {
		const schemaClient1 = await makeClient({
			label: "schema-client1",
			schema: testsRuntimeSchema,
		})
		const schemaClient2 = await makeClient({
			label: "schema-client2",
			schema: testsRuntimeSchema,
		})
		await Promise.all([schemaClient1.connect(), schemaClient2.connect()])

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
		await schemaClient1.commit(tx)

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
	})

	test("syncs remote updates that move records out of subscribed where filters", async ({
		client1,
		client2,
	}) => {
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
		await client1.commit(seedTx)

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
		await client1.commit(completeTx)

		await vi.waitFor(() => {
			expect(seenByClient2).toEqual([
				[todo("todo-1", { text: "Write the sync spec", priority: 2 })],
				[],
			])
		})
	})

	test("pulls relational snapshots after subscribing with an advanced cookie", async ({
		threadClients,
	}) => {
		const { client1, client2 } = threadClients

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
		await client1.commit(seedTx)

		// Pulling with an empty scan window advances the cookie without loading records
		await client2.pullFromRemote()
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
		await client2.pullFromRemote()
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
	})

	test("applies snapshot where filters while storing full records", async ({
		threadClients,
	}) => {
		const { client1, client2 } = threadClients

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
		await client1.commit(seedTx)

		// Pulling with an empty scan window advances the cookie without loading records
		await client2.pullFromRemote()
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
		await client2.pullFromRemote()
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
	})

	test("syncs remote one-to-many relation changes into subscribed results", async ({
		threadClients,
	}) => {
		const { client1, client2 } = threadClients

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
		await client2.pullFromRemote()

		// A remote parent appears first with an empty included relation array
		const seedTx = client1.transact()
		seedTx.set("threads", {
			id: "thread-1",
			ownerId: "user-1",
			title: "Active thread",
			status: "active",
		})
		await client1.commit(seedTx)

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
		await client1.commit(addMessageTx)

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

		const unrelatedTx = client1.transact()
		unrelatedTx.set("users", {
			id: "user-1",
			profileId: "profile-1",
			name: "Ada",
		})
		await client1.commit(unrelatedTx)
		await new Promise((resolve) => setTimeout(resolve, 10))

		// Unrelated collections do not re-emit the relational subscription
		expect(seenByClient2).toEqual([
			[{ id: "thread-1", messages: [] }],
			[{ id: "thread-1", messages: [{ body: "First message" }] }],
		])
	})

	test("syncs remote one-to-many relation removals into subscribed results", async ({
		threadClients,
	}) => {
		const { client1, client2 } = threadClients

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
		await client2.pullFromRemote()

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
		await client1.commit(seedTx)

		await vi.waitFor(() => {
			expect(seenByClient2).toEqual([
				[{ id: "thread-1", messages: [{ body: "First message" }] }],
			])
		})

		// Removing the included child should re-emit the parent with an empty relation array
		const removeMessageTx = client1.transact()
		removeMessageTx.remove("messages", "message-1")
		await client1.commit(removeMessageTx)

		await vi.waitFor(() => {
			expect(seenByClient2).toEqual([
				[{ id: "thread-1", messages: [{ body: "First message" }] }],
				[{ id: "thread-1", messages: [] }],
			])
		})
	})

	test("syncs remote nested relation changes into subscribed results", async ({
		threadClients,
	}) => {
		const { client1, client2 } = threadClients

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
		await client2.pullFromRemote()

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
		await client1.commit(seedTx)

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
		await client1.commit(updateProfileTx)

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
			push: async (args) => {
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

		client1.subscribe({ collection: "todos" }, () => {})
		client2.subscribe({ collection: "todos" }, () => {})

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
		const server = makeRemote<ThreadTestSchema>()
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
		const client1 = await makeClient({
			label: "relational-replay-client1",
			schema: threadTestSchema,
			relations: threadTestRelations,
			remote: delayedServer,
		})
		const client2 = await makeClient({
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
		client1.subscribe(threadWithMessagesQuery, () => {})
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

	test("reloads persisted records after recreating the app", async ({
		makeClient,
	}) => {
		// Commit records with the first client
		const firstClient = await makeClient({
			label: "persistent-client-1",
			remote: false,
			storage: { dbName: "persisted-todos" },
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
			storage: { dbName: "persisted-todos" },
		})

		const persistedTodosOnReload = secondClient.query({
			collection: "todos",
			orderBy: { priority: "asc" },
		})

		expect(persistedTodosOnReload).toEqual([
			todo("todo-1", { text: "Write the sync spec", priority: 2 }),
			todo("todo-3", { text: "Fix the sync bug", priority: 3 }),
		])
	})

	test("reloads persisted records through schema-owned codecs", async ({
		makeClient,
		makeStorage,
		rng,
	}) => {
		const dbName = rng.next("schema-codec-events")
		const firstStorage = makeStorage<TestsEventSchema>({
			dbName,
			schema: testsEventRuntimeSchema,
		})
		const firstClient = await makeClient({
			label: "schema-codec-client-1",
			remote: false,
			schema: testsEventRuntimeSchema,
			storage: firstStorage,
		})

		// Commit an event whose runtime value relies on the schema-owned codec
		const event = {
			id: "event-1",
			title: "Planning",
			startAt: new EventStart("2026-05-04T12:00:00.000Z"),
		}
		const tx = firstClient.transact()
		tx.set("events", event)
		await firstClient.commit(tx)
		await firstClient.flushStorage()
		await firstStorage.close()

		const secondClient = await makeClient({
			label: "schema-codec-client-2",
			remote: false,
			schema: testsEventRuntimeSchema,
			storage: makeStorage<TestsEventSchema>({
				dbName,
				schema: testsEventRuntimeSchema,
			}),
		})

		// Recreated storage decodes the persisted value back to the runtime shape
		const persistedEvents = secondClient.query({ collection: "events" })

		expect(persistedEvents).toEqual([event])
		expect(persistedEvents[0]?.startAt).toBeInstanceOf(EventStart)
	})

	test("keeps explicit IndexedDB codec support without a runtime schema", async ({
		makeClient,
		makeStorage,
		rng,
	}) => {
		const dbName = rng.next("explicit-codec-events")
		const firstStorage = makeStorage<TestsEventSchema>({
			dbName,
			codecs: { events: eventCodec },
		})
		const firstClient = await makeClient<TestsEventSchema>({
			label: "explicit-codec-client-1",
			remote: false,
			storage: firstStorage,
		})

		// Existing explicit storage codecs still encode persisted writes
		const event = {
			id: "event-1",
			title: "Planning",
			startAt: new EventStart("2026-05-04T12:00:00.000Z"),
		}
		const tx = firstClient.transact()
		tx.set("events", event)
		await firstClient.commit(tx)
		await firstClient.flushStorage()
		await firstStorage.close()

		const secondClient = await makeClient<TestsEventSchema>({
			label: "explicit-codec-client-2",
			remote: false,
			storage: makeStorage<TestsEventSchema>({
				dbName,
				codecs: { events: eventCodec },
			}),
		})

		// Recreated storage decodes through the explicit codec as before
		const persistedEvents = secondClient.query({ collection: "events" })

		expect(persistedEvents).toEqual([event])
		expect(persistedEvents[0]?.startAt).toBeInstanceOf(EventStart)
	})
})
