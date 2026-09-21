import { describe, expect, vi } from "vitest"
import {
	expectQuery,
	test,
	testsRuntimeSchema,
	todo,
	type TestsTodo,
} from "./fixtures"

describe("TandemClient sync", () => {
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
})
