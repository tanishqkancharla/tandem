import { describe, expect, test } from "vitest"
import { createApp, eventually, todo } from "./fixtures.js"

describe("Durable Object coordinator over an app-owned D1 database", () => {
	test("two clients converge on inserts, updates, and deletes stored in D1", async () => {
		await using app = createApp()
		const { client: alice } = await app.connectClient({ subject: "alice" })
		const { client: bob } = await app.connectClient({ subject: "bob" })
		alice.subscribe({ collection: "todos" })
		bob.subscribe({ collection: "todos" })

		// Alice's insert reaches Bob and is a row in the app's own table
		const insertTx = alice.transact()
		insertTx.set("todos", todo("milk", { title: "Buy milk" }))
		await alice.commit(insertTx)
		await eventually(() =>
			expect(bob.query({ collection: "todos" })).toEqual([
				todo("milk", { title: "Buy milk" }),
			]),
		)
		expect(app.todos()).toEqual([{ id: "milk", title: "Buy milk", done: 0 }])

		// Bob's update reaches Alice
		const updateTx = bob.transact()
		updateTx.set("todos", todo("milk", { title: "Buy milk", done: true }))
		await bob.commit(updateTx)
		await eventually(() =>
			expect(alice.query({ collection: "todos" })).toEqual([
				todo("milk", { title: "Buy milk", done: true }),
			]),
		)

		// Alice's delete removes the row and Bob's copy
		const removeTx = alice.transact()
		removeTx.remove("todos", "milk")
		await alice.commit(removeTx)
		await eventually(() =>
			expect(bob.query({ collection: "todos" })).toEqual([]),
		)
		expect(app.todos()).toEqual([])
	})

	test("subscriptions receive initial snapshots and window changes", async () => {
		await using app = createApp()
		app.database.sql(
			`INSERT INTO todos VALUES ('a', 'Open', 0, 1), ('b', 'Finished', 1, 2)`,
		)
		const { client } = await app.connectClient()

		// A filtered subscription receives only its matching snapshot
		const open = client.subscribe({
			collection: "todos",
			where: { done: false },
		})
		await eventually(() =>
			expect(client.query({ collection: "todos" })).toEqual([
				todo("a", { title: "Open" }),
			]),
		)

		// Widening the window adds the other record
		const all = client.subscribe({ collection: "todos" })
		await eventually(() =>
			expect(client.query({ collection: "todos" })).toHaveLength(2),
		)

		// Narrowing it again drops the record outside every subscription
		all.destroy()
		await client.pullFromRemote()
		expect(client.query({ collection: "todos" })).toEqual([
			todo("a", { title: "Open" }),
		])
		open.destroy()
	})

	test("an invalidation after an external SQL write pokes connected clients without polling", async () => {
		await using app = createApp()
		const { client: alice } = await app.connectClient({ subject: "alice" })
		const { client: bob } = await app.connectClient({ subject: "bob" })
		alice.subscribe({ collection: "todos" })
		bob.subscribe({ collection: "todos" })
		await eventually(() => expect(app.sockets).toHaveLength(2))
		await alice.pullFromRemote()
		await bob.pullFromRemote()

		// Idle clients send nothing to the coordinator
		const sentBefore = app.sockets.map((socket) => socket.sent.length)
		await new Promise((resolve) => setTimeout(resolve, 300))
		expect(app.sockets.map((socket) => socket.sent.length)).toEqual(sentBefore)

		// A plain SQL write is invisible until the app invalidates the coordinator
		app.database.sql(`INSERT INTO todos VALUES ('sql', 'From SQL', 0, 5)`)
		await new Promise((resolve) => setTimeout(resolve, 50))
		expect(bob.query({ collection: "todos" })).toEqual([])
		expect(await app.coordinator.core.invalidate()).toBe(2)
		await eventually(() => {
			expect(alice.query({ collection: "todos" })).toEqual([
				todo("sql", { title: "From SQL", createdAt: 5 }),
			])
			expect(bob.query({ collection: "todos" })).toEqual([
				todo("sql", { title: "From SQL", createdAt: 5 }),
			])
		})
	})

	test("a poke during an in-flight pull leads to another pull with the newer write", async () => {
		await using app = createApp()
		const { client } = await app.connectClient()
		client.subscribe({ collection: "todos" })
		await client.pullFromRemote()

		// The pull reads storage after the first external write is visible
		const gate = app.coordinator.pauseNextScan()
		app.database.sql(`INSERT INTO todos VALUES ('first', 'First', 0, 1)`)
		const pull = client.pullFromRemote()
		await gate.reached

		// A second write and its poke arrive while that pull is still in flight
		await app.externalWrite(
			`INSERT INTO todos VALUES ('second', 'Second', 0, 2)`,
		)
		gate.open()
		await pull
		await eventually(() =>
			expect(client.query({ collection: "todos" })).toEqual([
				todo("first", { title: "First" }),
				todo("second", { title: "Second", createdAt: 2 }),
			]),
		)
	})

	test("a reconnecting client catches up on writes whose pokes it missed", async () => {
		await using app = createApp()
		const { client } = await app.connectClient()
		client.subscribe({ collection: "todos" })
		await client.pullFromRemote()

		// The socket drops, then a write and invalidation happen while disconnected
		app.sockets[0]!.close(1006, "network lost")
		await app.externalWrite(
			`INSERT INTO todos VALUES ('missed', 'Missed', 0, 1)`,
		)

		// Reconnecting pulls before anything else, so the client converges
		await eventually(() =>
			expect(client.query({ collection: "todos" })).toEqual([
				todo("missed", { title: "Missed" }),
			]),
		)
		expect(app.sockets).toHaveLength(2)
	})

	test("a retried push after a lost acknowledgement does not resurrect a later delete", async () => {
		await using app = createApp()
		const { client: alice } = await app.connectClient({ subject: "alice" })
		const { client: bob } = await app.connectClient({ subject: "bob" })
		alice.subscribe({ collection: "todos" })
		bob.subscribe({ collection: "todos" })

		// Alice's write commits in D1, but its acknowledgement is lost
		app.coordinator.loseNextPushResponse()
		const lostTx = alice.transact()
		lostTx.set("todos", todo("draft", { title: "Draft" }))
		await expect(alice.commit(lostTx)).rejects.toThrow()
		expect(app.todos()).toEqual([{ id: "draft", title: "Draft", done: 0 }])

		// Bob deletes it, and the coordinator loses its memory
		await eventually(() =>
			expect(bob.query({ collection: "todos" })).toHaveLength(1),
		)
		const removeTx = bob.transact()
		removeTx.remove("todos", "draft")
		await bob.commit(removeTx)
		app.coordinator.start()

		// Alice's next push resends the unacknowledged mutation, which D1 skips
		const nextTx = alice.transact()
		nextTx.set("todos", todo("next", { title: "Next" }))
		await alice.commit(nextTx)
		expect(app.todos()).toEqual([{ id: "next", title: "Next", done: 0 }])
		await eventually(() =>
			expect(alice.query({ collection: "todos" })).toEqual([
				todo("next", { title: "Next" }),
			]),
		)
	})

	test("clients recover from coordinator memory loss with and without surviving sockets", async () => {
		await using app = createApp()
		const { client: alice } = await app.connectClient({ subject: "alice" })
		const { client: bob } = await app.connectClient({ subject: "bob" })
		alice.subscribe({ collection: "todos" })
		bob.subscribe({ collection: "todos" })
		await app.externalWrite(`INSERT INTO todos VALUES ('kept', 'Kept', 0, 1)`)
		await eventually(() =>
			expect(bob.query({ collection: "todos" })).toHaveLength(1),
		)

		// Woken from hibernation: sockets survive, views do not, and pokes still arrive
		app.coordinator.start()
		await app.externalWrite(`DELETE FROM todos WHERE id = 'kept'`)
		await eventually(() => {
			expect(alice.query({ collection: "todos" })).toEqual([])
			expect(bob.query({ collection: "todos" })).toEqual([])
		})

		// Restarted: sockets close, clients reconnect, and later writes still sync
		app.coordinator.restartClosingSockets()
		await eventually(() => expect(app.coordinator.sockets.size).toBe(2))
		const tx = alice.transact()
		tx.set("todos", todo("after", { title: "After restart" }))
		await alice.commit(tx)
		await eventually(() =>
			expect(bob.query({ collection: "todos" })).toEqual([
				todo("after", { title: "After restart" }),
			]),
		)
	})

	test("apps are isolated: separate data, pokes, and tokens", async () => {
		await using first = createApp("first-app")
		await using second = createApp("second-app")
		const { client: firstClient } = await first.connectClient()
		const { client: secondClient } = await second.connectClient()
		firstClient.subscribe({ collection: "todos" })
		secondClient.subscribe({ collection: "todos" })

		// A write and invalidation in one app never reach the other
		await first.externalWrite(
			`INSERT INTO todos VALUES ('only-first', 'First', 0, 1)`,
		)
		await eventually(() =>
			expect(firstClient.query({ collection: "todos" })).toHaveLength(1),
		)
		await secondClient.pullFromRemote()
		expect(secondClient.query({ collection: "todos" })).toEqual([])
		expect(second.coordinator.core.stats().pokes).toBe(0)

		// A token minted for another app is rejected at the upgrade
		await expect(
			second.connectClient({ tokenAppId: "first-app", reconnect: false }),
		).rejects.toThrow()
	})

	test("invalid pushes are rejected without writing to D1", async () => {
		await using app = createApp()
		const { client, remote } = await app.connectClient()

		// A mutation for a collection the app does not sync
		const response = await remote.push({
			clientId: client.clientId,
			mutations: [
				{
					id: 1,
					ops: [{ type: "set", collection: "secrets", value: { id: "x" } }],
				},
			],
		} as unknown as Parameters<typeof remote.push>[0])
		expect(response).toMatchObject({ error: "invalid-request" })
		expect(app.todos()).toEqual([])

		// An oversized message closes the socket
		app.sockets[0]!.send("x".repeat(1024 * 1024 + 1))
		await eventually(() =>
			expect(app.sockets[0]!.readyState).toBe(app.sockets[0]!.CLOSED),
		)
	})
})
