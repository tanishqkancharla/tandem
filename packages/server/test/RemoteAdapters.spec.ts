import { describe, expect, vi } from "vitest"
import { createRemoteAdapterTest, remoteProviders, thread } from "./fixtures"

describe.each(remoteProviders)("$name remote", (provider) => {
	const test = createRemoteAdapterTest(provider)

	test("push set stores row", async ({ client, context }) => {
		await client.connect()
		const tx = client.transact()
		tx.set("threads", thread("thread-1", { title: "Write tests" }))
		await client.commit(tx)

		await context.assertStored([thread("thread-1", { title: "Write tests" })])
	})

	test("push remove deletes row", async ({ client, context }) => {
		await client.connect()
		const setTx = client.transact()
		setTx.set("threads", thread("thread-1"))
		await client.commit(setTx)

		const removeTx = client.transact()
		removeTx.remove("threads", "thread-1")
		await client.commit(removeTx)

		await context.assertStored([])
	})

	test("pull reads seeded rows", async ({ client, context }) => {
		const seeded = [
			thread("thread-1", { title: "Seeded remotely", createdAt: 4 }),
		]

		await context.seed?.(seeded)
		await client.connect()
		const subscription = client.subscribe({ collection: "threads" })
		await client.pullFromRemote()

		expect(client.query({ collection: "threads" })).toEqual(seeded)
		subscription.destroy()
	})

	test("query operators are respected", async ({ client, context }) => {
		const records = [
			thread("thread-1", { title: "Low open", createdAt: 1 }),
			thread("thread-2", {
				title: "Closed high",
				status: "closed",
				createdAt: 5,
			}),
			thread("thread-3", { title: "Middle open", createdAt: 3 }),
			thread("thread-4", { title: "High open", createdAt: 4 }),
			thread("thread-5", { title: "Too high open", createdAt: 6 }),
		]

		await context.seed?.(records)
		await client.connect()
		const query = {
			collection: "threads",
			where: { status: "open", createdAt: { lte: 4 } },
			orderBy: { createdAt: "desc" },
			limit: 2,
			offset: 1,
		} as const
		const subscription = client.subscribe(query)
		await client.pullFromRemote()

		expect(
			client.query({
				collection: "threads",
				orderBy: { createdAt: "desc" },
			}),
		).toEqual([
			thread("thread-3", { title: "Middle open", createdAt: 3 }),
			thread("thread-1", { title: "Low open", createdAt: 1 }),
		])
		subscription.destroy()
	})

	test("poke updates subscribed client", async ({ client1, client2 }) => {
		await client2.connect()
		const subscription = client2.subscribe({ collection: "threads" })
		await client2.pullFromRemote()

		await client1.connect()
		const tx = client1.transact()
		tx.set("threads", thread("thread-1", { title: "Poked", createdAt: 3 }))
		await client1.commit(tx)

		await vi.waitFor(() => {
			expect(client2.query({ collection: "threads" })).toEqual([
				thread("thread-1", { title: "Poked", createdAt: 3 }),
			])
		})

		subscription.destroy()
	})
})
