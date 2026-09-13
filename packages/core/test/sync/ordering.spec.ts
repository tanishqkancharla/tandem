import { expect } from "vitest"
import { todo } from "../fixtures"
import { test } from "./fixtures"

test("the last write reaching the server wins, even when it was started first", async ({
	gatekeeper: { client1, client2, server },
}) => {
	// Client1 edits locally, with its write still outside the server.
	const firstTodo = todo("shared", { text: "Client1's title" })
	const firstTx = client1.transact()
	firstTx.set("todos", firstTodo)
	const first = await client1.commit(firstTx).hold()
	expect(client1.todos()).toEqual([firstTodo])
	expect(client2.todos()).toEqual([])

	// Client2's independent write reaches the server first.
	const secondTodo = todo("shared", { done: true })
	const secondTx = client2.transact()
	secondTx.set("todos", secondTodo)
	const second = await client2.commit(secondTx).hold()
	await second.continueUntil({ afterProcessedBy: server })
	await second.continue()
	expect(client1.todos()).toEqual([firstTodo])

	// Client1 arrives last. Both clients converge on its complete record.
	await first.continue()
	await client1.pullFromRemote()
	await client2.pullFromRemote()
	expect(client1.todos()).toEqual([firstTodo])
	expect(client2.todos()).toEqual([firstTodo])
})

test("another client can read an accepted write while its acknowledgement is held", async ({
	gatekeeper: { client1, client2, server },
}) => {
	const savedTodo = todo("accepted", { text: "Saved before acknowledgement" })
	const tx = client1.transact()
	tx.set("todos", savedTodo)
	const call = await client1.commit(tx).hold()

	// The server processes Client1's write but has not delivered its response.
	await call.continueUntil({ afterProcessedBy: server })
	await client2.pullFromRemote()
	expect(client2.todos()).toEqual([savedTodo])
	expect(client1.todos()).toEqual([savedTodo])

	// Delivering the acknowledgement completes the original commit.
	await call.continue()
	await client1.pullFromRemote()
	expect(client1.todos()).toEqual([savedTodo])
})

test("a failed outgoing write rolls back locally and never appears on the other client", async ({
	gatekeeper: { client1, client2 },
}) => {
	const rejectedTodo = todo("rejected", { text: "This write will fail" })
	const tx = client1.transact()
	tx.set("todos", rejectedTodo)
	const call = await client1.commit(tx).hold()
	expect(client1.todos()).toEqual([rejectedTodo])

	// A transport failure goes through Tandem's actual rollback path.
	const failure = new Error("Connection closed before delivery")
	await expect(call.fail(failure)).rejects.toBe(failure)
	expect(client1.todos()).toEqual([])
	await client2.pullFromRemote()
	expect(client2.todos()).toEqual([])
})
