import { expect as baseExpect } from "extendable-expect"
import { isEqual } from "lodash-es"
import {
	AsyncTupleDatabase,
	AsyncTupleStorageApi,
	InMemoryTupleStorage,
	WriteOps,
} from "tuple-database"
import { beforeEach, describe, it, vi } from "vitest"
import { Database } from "./Database"

const expect = baseExpect.extend({
	async toEventuallyReturn<T>(
		fn: () => T | Promise<T>,
		value: T,
	): Promise<void> {
		await new Promise<void>((resolve, reject) => {
			const now = Date.now()

			const check = async () => {
				try {
					const result = await fn()
					if (isEqual(result, value)) {
						resolve()
					} else if (Date.now() - now > 1000) {
						reject(
							new Error(
								`Expected "${JSON.stringify(value)}" but got "${JSON.stringify(result)}"`,
							),
						)
					} else {
						setTimeout(check, 2)
					}
				} catch (error) {
					reject(error)
				}
			}

			check().catch(reject)
		})
	},

	async toReject(promise: Promise<any>, expectedError: string): Promise<void> {
		try {
			await promise
			throw new Error(
				"Expected promise to reject, but it resolved successfully",
			)
		} catch (error: any) {
			if (error.message === expectedError) return Promise.resolve()
			else
				throw new Error(
					`Expected error message "${expectedError}", but got: "${error.message}"`,
				)
		}
	},
})

describe("LocalDatabase", () => {
	type TodoSchema = {
		todos: {
			id: string
			text: string
			complete: boolean
			order?: number
		}
		lists: {
			id: string
			name: string
		}
	}

	type Todo = TodoSchema["todos"]
	type List = TodoSchema["lists"]

	let db: Database<TodoSchema>
	let storage: AsyncTupleDatabase

	beforeEach(() => {
		storage = new AsyncTupleDatabase(new InMemoryTupleStorage())
		db = new Database<TodoSchema>(storage)
	})

	describe("Basic CRUD operations", () => {
		it("updates existing records", () => {
			const tx = db.transact()
			tx.set("todos", { id: "1", text: "original", complete: false })
			tx.commit()

			const tx2 = db.transact()
			tx2.set("todos", { id: "1", text: "updated", complete: true })
			tx2.commit()

			expect(db.get("todos", "1")).toEqual({
				id: "1",
				text: "updated",
				complete: true,
			})
		})

		it("handles multiple collections", () => {
			const TODO_1 = { id: "1", text: "todo", complete: false }
			const LIST_1 = { id: "list1", name: "My List" }

			const tx = db.transact()
			tx.set("todos", TODO_1)
			tx.set("lists", LIST_1)
			tx.commit()

			expect(db.get("todos", "1")).toEqual(TODO_1)
			expect(db.get("lists", "list1")).toEqual(LIST_1)
		})

		it("handles batch operations", () => {
			const tx = db.transact()
			for (let i = 0; i < 100; i++) {
				tx.set("todos", {
					id: `todo-${i}`,
					text: `Todo ${i}`,
					complete: false,
				})
			}
			tx.commit()

			expect(db.list("todos")).toHaveLength(100)
		})
	})

	describe("Subscription and reactivity", () => {
		it("notifies subscribers of changes", async () => {
			const changes: Todo[][] = []
			const { result, destroy } = db.subscribe(
				(db) => db.list("todos"),
				(result) => changes.push(result),
			)
			changes.push(result)

			const tx = db.transact()
			tx.set("todos", { id: "1", text: "test", complete: false })
			tx.commit()

			await expect(() => changes).toEventuallyReturn([
				[],
				[{ id: "1", text: "test", complete: false }],
			])

			destroy()
		})

		it("handles multiple subscribers", async () => {
			const changes1: Todo[][] = []
			const changes2: Todo[][] = []

			const sub1 = db.subscribe(
				(db) => db.list("todos"),
				(result) => changes1.push(result),
			)
			changes1.push(sub1.result)
			const sub2 = db.subscribe(
				(db) => db.list("todos"),
				(result) => changes2.push(result),
			)
			changes2.push(sub2.result)

			const tx = db.transact()
			tx.set("todos", { id: "1", text: "test", complete: false })
			tx.commit()

			await expect(() => changes1).toEventuallyReturn([
				[],
				[{ id: "1", text: "test", complete: false }],
			])
			await expect(() => changes2).toEventuallyReturn([
				[],
				[{ id: "1", text: "test", complete: false }],
			])

			sub1.destroy()
			sub2.destroy()
		})
	})

	describe("Transaction handling", () => {
		it("rolls back failed transactions completely", async () => {
			// Setup initial state
			const tx = db.transact()
			tx.set("todos", { id: "1", text: "stable", complete: false })
			tx.commit()

			// Create failing storage
			const failingStorage: AsyncTupleStorageApi = {
				async scan() {
					const results = await storage.scan()
					return results
				},
				async commit() {
					throw new Error("Simulated failure")
				},
				close: () => Promise.resolve(),
			}

			const failingDb = new Database<TodoSchema>(failingStorage)
			await failingDb.ready

			// Attempt complex transaction
			const failingTx = failingDb.transact()
			failingTx.set("todos", { id: "2", text: "new", complete: false })
			failingTx.set("todos", { id: "1", text: "modified", complete: true })
			failingTx.commit()

			// Verify rollback
			await expect(() => failingDb.list("todos")).toEventuallyReturn([
				{ id: "1", text: "stable", complete: false },
			])
		})

		it("handles concurrent transactions", () => {
			const tx1 = db.transact()
			const tx2 = db.transact()

			tx1.set("todos", { id: "1", text: "first", complete: false })
			tx2.set("todos", { id: "2", text: "second", complete: false })

			tx1.commit()
			tx2.commit()

			expect(db.list("todos")).toHaveLength(2)
		})
	})

	describe("Storage synchronization", () => {
		it("loads initial state correctly", async () => {
			// Prepare initial state
			await storage.commit({
				set: [
					{
						key: ["record", "todos", "1"],
						value: { id: "1", text: "existing", complete: false },
					},
				],
			})

			// Create new database instance
			const newDb = new Database<TodoSchema>(storage)
			await newDb.ready

			expect(newDb.list("todos")).toEqual([
				{ id: "1", text: "existing", complete: false },
			])
		})

		it("handles delayed storage operations", async () => {
			const delayedStorage: AsyncTupleStorageApi = {
				async scan() {
					await new Promise((resolve) => setTimeout(resolve, 100))
					return storage.scan()
				},
				async commit(ops) {
					await new Promise((resolve) => setTimeout(resolve, 100))
					return storage.commit(ops)
				},
				close: () => Promise.resolve(),
			}

			const slowDb = new Database<TodoSchema>(delayedStorage)
			await slowDb.ready

			const tx = slowDb.transact()
			tx.set("todos", { id: "1", text: "slow", complete: false })
			tx.commit()

			await expect(() => slowDb.list("todos")).toEventuallyReturn([
				{ id: "1", text: "slow", complete: false },
			])
		})
	})

	describe("Error handling", () => {
		it("handles storage initialization failures", async () => {
			const failingStorage: AsyncTupleStorageApi = {
				scan: () => Promise.reject(new Error("Scan failed")),
				commit: () => Promise.reject(new Error("Commit failed")),
				close: () => Promise.resolve(),
			}

			const failingDb = new Database<TodoSchema>(failingStorage)
			await expect(failingDb.ready).toReject("Scan failed")
		})

		it("maintains consistency after failed operations", async () => {
			let failNext = false

			const commitMock = vi.fn((ops: WriteOps) => {
				return storage.commit(ops)
			})

			const intermittentStorage: AsyncTupleStorageApi = {
				async scan() {
					return storage.scan()
				},
				commit: commitMock,
				close: () => Promise.resolve(),
			}

			const db = new Database<TodoSchema>(intermittentStorage)
			await db.ready

			// Successful operation
			const tx1 = db.transact()
			tx1.set("todos", { id: "1", text: "stable", complete: false })
			tx1.commit()

			// Failed operation
			commitMock.mockRejectedValueOnce(new Error("Mocked storage failure"))
			const tx2 = db.transact()
			tx2.set("todos", { id: "2", text: "should fail", complete: false })
			tx2.commit()

			// Verify state after failure
			await expect(() => db.list("todos")).toEventuallyReturn([
				{ id: "1", text: "stable", complete: false },
			])

			// Verify can still perform operations
			const tx3 = db.transact()
			tx3.set("todos", { id: "3", text: "after failure", complete: false })
			tx3.commit()

			await expect(() => db.list("todos")).toEventuallyReturn([
				{ id: "1", text: "stable", complete: false },
				{ id: "3", text: "after failure", complete: false },
			])
		})
	})
})
