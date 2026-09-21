import { describe, expect } from "vitest"
import { todo } from "../fixtures"
import { test } from "./fixtures"

describe("Tandem client sync ordering", () => {
	test("shows a newer edit while the previous push is in flight", async ({
		gatekeeper,
	}) => {
		const { client1 } = gatekeeper
		const firstTodo = todo("queued", { text: "First title" })
		const firstTx = client1.transact()
		firstTx.set("todos", firstTodo)

		await gatekeeper.activateGates()
		const first = await client1.commit(firstTx)
		const secondTodo = todo("queued", { text: "Final title" })
		const secondTx = client1.transact()
		secondTx.set("todos", secondTodo)
		void client1.commit(secondTx)

		first.assertSentBy("client1").assertWaitingFor("server")
		expect(client1.todos()).toEqual([secondTodo])
	})

	test("makes a server-accepted edit visible before acknowledging it", async ({
		gatekeeper,
	}) => {
		const { client1, client2 } = gatekeeper
		const acceptedTodo = todo("accepted", { text: "Accepted title" })
		const tx = client1.transact()
		tx.set("todos", acceptedTodo)

		await gatekeeper.activateGates()
		const commit = await client1.commit(tx)
		await commit.continueTo("server")
		const pull = await client2.pullFromRemote()
		await pull.continueToCompletion()

		commit.assertSentBy("server").assertWaitingFor("client1")
		pull.assertCompleted()
		expect(client2.todos()).toEqual([acceptedTodo])
	})

	test("releases a queued edit after acknowledging the previous push", async ({
		gatekeeper,
	}) => {
		const { client1 } = gatekeeper
		const firstTodo = todo("queued", { text: "First title" })
		const firstTx = client1.transact()
		firstTx.set("todos", firstTodo)

		await gatekeeper.activateGates()
		const first = await client1.commit(firstTx)
		const secondTodo = todo("queued", { text: "Final title" })
		const secondTx = client1.transact()
		secondTx.set("todos", secondTodo)
		const secondReady = client1.commit(secondTx)

		await first.continueToCompletion()
		const second = await secondReady
		await second.continueToCompletion()

		first.assertCompleted()
		expect(await first.result).toBeUndefined()
		second.assertCompleted()
		expect(client1.todos()).toEqual([secondTodo])
	})

	test("syncs a queued edit after the previous push is acknowledged", async ({
		gatekeeper,
	}) => {
		const { client1, client2 } = gatekeeper
		const firstTx = client1.transact()
		firstTx.set("todos", todo("queued", { text: "First title" }))
		await gatekeeper.activateGates()
		const first = await client1.commit(firstTx)
		const secondTodo = todo("queued", { text: "Final title" })
		const secondTx = client1.transact()
		secondTx.set("todos", secondTodo)
		const secondReady = client1.commit(secondTx)

		await first.continueToCompletion()
		const second = await secondReady
		await second.continueToCompletion()
		const pull = await client2.pullFromRemote()
		await pull.continueToCompletion()

		first.assertCompleted()
		expect(await first.result).toBeUndefined()
		second.assertCompleted()
		pull.assertCompleted()
		expect(client2.todos()).toEqual([secondTodo])
	})

	test("rejects a commit when its acknowledgement is lost", async ({
		gatekeeper,
	}) => {
		const { client1 } = gatekeeper
		const tx = client1.transact()
		tx.set("todos", todo("lost-ack", { text: "Accepted title" }))
		const failure = new Error("Connection closed before acknowledgement")

		await gatekeeper.activateGates()
		const commit = await client1.commit(tx)
		await commit.continueTo("server")

		await commit.fail(failure)

		commit.assertCompleted()
		await expect(commit.result).rejects.toBe(failure)
	})

	test("keeps a server-accepted edit after its acknowledgement is lost", async ({
		gatekeeper,
	}) => {
		const { client1, client2 } = gatekeeper
		const acceptedTodo = todo("accepted-without-ack", {
			text: "Stored despite the lost response",
		})
		const tx = client1.transact()
		tx.set("todos", acceptedTodo)
		const failure = new Error("Connection closed before acknowledgement")

		await gatekeeper.activateGates()
		const commit = await client1.commit(tx)
		const commitSettled = Promise.allSettled([commit.result])
		await commit.continueTo("server")
		await commit.fail(failure)
		const pull = await client2.pullFromRemote()
		await pull.continueToCompletion()

		pull.assertCompleted()
		expect(client2.todos()).toEqual([acceptedTodo])

		await commitSettled
	})
})
