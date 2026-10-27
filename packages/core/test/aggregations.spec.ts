import { TandemClient } from "@tanishqkancharla/tandem-core"
import { describe, expect, test, vi } from "vitest"

type Schema = {
	threads: {
		id: string
		workspaceId: string
		replyCount: number
		active: boolean
	}
}

function thread(
	id: string,
	workspaceId: string,
	replyCount: number,
	active = true,
): Schema["threads"] {
	return { id, workspaceId, replyCount, active }
}

describe("callback aggregations", () => {
	test("tracks compound source IDs independently", async () => {
		type CompoundSchema = {
			items: { id: readonly [string, string]; bucket: string; value: number }
		}
		const client = new TandemClient<CompoundSchema>({})
		await client.ready
		const observed: unknown[] = []
		const subscription = client.subscribe(
			{
				collection: "items",
				groupBy: ["bucket"],
				aggregate: (rows) => ({
					total: rows.reduce((sum, row) => sum + row.value, 0),
				}),
			},
			(value) => observed.push(value),
		)
		const tx = client.transact()
		tx.set("items", { id: ["one", "a"], bucket: "shared", value: 2 })
		tx.set("items", { id: ["one", "b"], bucket: "shared", value: 3 })
		await client.commit(tx)
		expect(observed.at(-1)).toEqual([{ bucket: "shared", total: 5 }])
		const removeTx = client.transact()
		removeTx.remove("items", ["one", "a"])
		await client.commit(removeTx)
		expect(observed.at(-1)).toEqual([{ bucket: "shared", total: 3 }])
		subscription.destroy()
		await client.close()
	})

	test("returns scalar and object results, including empty inputs", async () => {
		const client = new TandemClient<Schema>({})
		await client.ready
		expect(
			client.query({ collection: "threads", aggregate: (rows) => rows.length }),
		).toBe(0)
		expect(
			client.query({
				collection: "threads",
				groupBy: ["workspaceId"],
				aggregate: (rows) => ({ count: rows.length }),
			}),
		).toEqual([])
		const tx = client.transact()
		tx.set("threads", thread("a", "one", 2))
		tx.set("threads", thread("b", "one", 4))
		await client.commit(tx)
		expect(
			client.query({
				collection: "threads",
				aggregate: (rows) =>
					rows.reduce((sum, row) => sum + row.replyCount, 0) / rows.length,
			}),
		).toBe(3)
		expect(
			client.query({
				collection: "threads",
				groupBy: ["workspaceId"],
				aggregate: (rows) => ({ count: rows.length }),
			}),
		).toEqual([{ workspaceId: "one", count: 2 }])
		await client.close()
	})

	test("updates affected groups once per transaction and removes empty groups", async () => {
		const client = new TandemClient<Schema>({})
		await client.ready
		const tx = client.transact()
		tx.set("threads", thread("a", "one", 2))
		tx.set("threads", thread("b", "two", 4))
		await client.commit(tx)
		const calls = { one: vi.fn(), two: vi.fn() }
		const observed: unknown[] = []
		const subscription = client.subscribe(
			{
				collection: "threads",
				where: { active: true },
				groupBy: ["workspaceId"],
				aggregate: (rows) => {
					calls[rows[0]!.workspaceId as "one" | "two"]()
					return {
						average:
							rows.reduce((sum, row) => sum + row.replyCount, 0) / rows.length,
					}
				},
			},
			(value) => observed.push(value),
		)
		expect(subscription.result).toEqual([
			{ workspaceId: "one", average: 2 },
			{ workspaceId: "two", average: 4 },
		])
		calls.one.mockClear()
		calls.two.mockClear()

		// One record update recomputes only its group.
		const updateTx = client.transact()
		updateTx.update("threads", "a", { replyCount: 6 })
		await client.commit(updateTx)
		expect(calls.one).toHaveBeenCalledTimes(1)
		expect(calls.two).not.toHaveBeenCalled()
		expect(observed.at(-1)).toEqual([
			{ workspaceId: "one", average: 6 },
			{ workspaceId: "two", average: 4 },
		])

		// Moving the row touches both groups in one published result.
		const moveTx = client.transact()
		moveTx.update("threads", "a", { workspaceId: "two" })
		await client.commit(moveTx)
		expect(observed.at(-1)).toEqual([{ workspaceId: "two", average: 5 }])
		expect(observed).toHaveLength(2)

		// A filter transition removes the last row in the group.
		const filterTx = client.transact()
		filterTx.update("threads", "b", { active: false })
		await client.commit(filterTx)
		expect(observed.at(-1)).toEqual([{ workspaceId: "two", average: 6 }])
		subscription.destroy()

		// Removing a subscription stops later notifications.
		const count = observed.length
		const afterDestroyTx = client.transact()
		afterDestroyTx.remove("threads", "a")
		await client.commit(afterDestroyTx)
		expect(observed).toHaveLength(count)
		await client.close()
	})

	test("rejects group collisions and incompatible list options", async () => {
		const client = new TandemClient<Schema>({})
		await client.ready
		const tx = client.transact()
		tx.set("threads", thread("a", "one", 1))
		await client.commit(tx)
		expect(() =>
			client.query({
				collection: "threads",
				groupBy: ["workspaceId"],
				aggregate: () => ({ workspaceId: "wrong" }),
			}),
		).toThrow(/conflicts with group key/)
		expect(() =>
			client.query({
				collection: "threads",
				limit: 1,
				aggregate: (rows: readonly Schema["threads"][]) => rows.length,
			} as never),
		).toThrow(/support only/)
		await client.close()
	})
})
