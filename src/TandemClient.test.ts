import { expect as baseExpect } from "extendable-expect"
import { InMemoryTupleStorage, WriteOps } from "tuple-database"
import { beforeEach, describe, test, vi } from "vitest"
import { TandemClient } from "./TandemClient"
import { TestRemote } from "./TestRemote"
import { AnySchema, CollectionName, StorageApi } from "./types"
import { LoggerApi, rootLogger } from "./utils/Logger"
import { isEqual } from "./utils/objectUtils"

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
								`Expected "${JSON.stringify(value)}" but got "${JSON.stringify(
									result,
								)}"`,
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
		let succeded = false

		try {
			await promise
			succeded = true
		} catch (error: any) {
			if (error.message === expectedError) return Promise.resolve()
			else {
				throw new Error(
					`Expected error message "${expectedError}", but got: "${error.message}"`,
				)
			}
		}

		if (succeded) {
			throw new Error(
				"Expected promise to reject, but it resolved successfully",
			)
		}
	},

	toThrow(fn: () => any, expectedError?: string): void {
		let succeded = false
		try {
			fn()
			succeded = true
		} catch (error: any) {
			if (expectedError && error.message === expectedError) return
			else {
				throw new Error(
					`Expected error message "${expectedError}", but got: "${error.message}"`,
				)
			}
		}

		if (succeded) {
			throw new Error("Expected task to throw error, but it ran successfully")
		}
	},
})

describe("Database", () => {
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

	// TODO: use fixtures instead
	let db: TandemClient<TodoSchema>
	let storage: StorageApi

	beforeEach(() => {
		let inMemoryStorage = new InMemoryTupleStorage()
		storage = {
			scan: async (args) => await inMemoryStorage.scan(args),
			commit: async (ops: WriteOps) => await inMemoryStorage.commit(ops),
			close: async () => await inMemoryStorage.close(),
			clear: async () => {
				inMemoryStorage = new InMemoryTupleStorage()
			},
		}

		db = new TandemClient<TodoSchema>({ storage })
	})

	const expectDb = <Schema extends AnySchema>(db: TandemClient<Schema>) => {
		return {
			list: <C extends CollectionName<Schema>>(collection: C) => {
				const { result } = db.subscribe(
					collection,
					(q) => q.select("*"),
					(result) => {
						latest = result
					},
				)

				let latest: Schema[C][] = result

				return {
					toEqual: (expected: Schema[C][]) => {
						expect(result as any[]).toEqual(expected)
					},
					toHaveLength: (expected: number) => {
						expect(result as any[]).toHaveLength(expected)
					},
					async toEventuallyEqual(expected: Schema[C][]) {
						await expect(() => latest).toEventuallyReturn(expected)
					},
					async toEventuallyHaveLength(expected: number) {
						await expect(() => latest).toEventuallyReturn(expected)
					},
				}
			},
			get: <C extends CollectionName<Schema>>(collection: C, id: string) => {
				const { result } = db.subscribe(
					collection,
					(q) => q.id(id),
					(result) => {
						latest = result[0]
					},
				)

				let latest: Schema[C] | undefined = result[0]

				return {
					toEqual: (expected: Schema[C]) => {
						expect(result[0]).toEqual(expected)
					},
					async toEventuallyEqual(expected: Schema[C]) {
						await expect(() => latest).toEventuallyReturn(expected)
					},
				}
			},
		}
	}

	describe("Clear functionality", () => {
		test("clears all data from database", async () => {
			// Add some initial data
			const tx1 = db.transact()
			tx1.set("todos", { id: "1", text: "first", complete: false })
			tx1.set("todos", { id: "2", text: "second", complete: true })
			tx1.set("lists", { id: "list1", name: "My List" })
			db.commit(tx1)

			// Verify data exists
			expectDb(db).list("todos").toHaveLength(2)
			expectDb(db).list("lists").toHaveLength(1)

			// Clear the database
			await db.clear()

			// Verify all data is cleared
			expectDb(db).list("todos").toHaveLength(0)
			expectDb(db).list("lists").toHaveLength(0)
		})

		test("can add data after clear", async () => {
			// Add initial data
			const tx1 = db.transact()
			tx1.set("todos", { id: "1", text: "original", complete: false })
			db.commit(tx1)

			// Clear the database
			await db.clear()

			// Add new data
			const tx2 = db.transact()
			tx2.set("todos", { id: "2", text: "after clear", complete: true })
			db.commit(tx2)

			// Verify only new data exists
			expectDb(db)
				.list("todos")
				.toEqual([{ id: "2", text: "after clear", complete: true }])
		})
	})

	describe("Basic CRUD operations", () => {
		test("updates existing records", () => {
			const tx = db.transact()
			tx.set("todos", { id: "1", text: "original", complete: false })
			db.commit(tx)

			const tx2 = db.transact()
			tx2.set("todos", { id: "1", text: "updated", complete: true })
			db.commit(tx2)

			expectDb(db).get("todos", "1").toEqual({
				id: "1",
				text: "updated",
				complete: true,
			})
		})

		test("handles multiple collections", () => {
			const TODO_1 = { id: "1", text: "todo", complete: false }
			const LIST_1 = { id: "list1", name: "My List" }

			const tx = db.transact()
			tx.set("todos", TODO_1)
			tx.set("lists", LIST_1)
			db.commit(tx)

			expectDb(db).get("todos", "1").toEqual(TODO_1)
			expectDb(db).get("lists", "list1").toEqual(LIST_1)
		})

		test("handles batch operations", () => {
			const tx = db.transact()
			for (let i = 0; i < 100; i++) {
				tx.set("todos", {
					id: `todo-${i}`,
					text: `Todo ${i}`,
					complete: false,
				})
			}
			db.commit(tx)

			expectDb(db).list("todos").toHaveLength(100)
		})
	})

	describe("Subscription and reactivity", () => {
		test("notifies subscribers of changes", () => {
			const changes: Todo[][] = []
			const { result, destroy } = db.subscribe(
				"todos",
				(q) => q.select("*"),
				(results) => changes.push(results),
			)
			changes.push(result)

			const tx = db.transact()
			tx.set("todos", { id: "1", text: "test", complete: false })
			db.commit(tx)

			expect(changes).toEqual([
				[],
				[{ id: "1", text: "test", complete: false }],
			])

			destroy()
		})

		test("handles multiple subscribers", () => {
			const changes1: Todo[][] = []
			const changes2: Todo[][] = []

			const sub1 = db.subscribe(
				"todos",
				(q) => q.select("*"),
				(result) => changes1.push(result),
			)
			changes1.push(sub1.result)
			const sub2 = db.subscribe(
				"todos",
				(q) => q.select("*"),
				(result) => changes2.push(result),
			)
			changes2.push(sub2.result)

			const tx = db.transact()
			tx.set("todos", { id: "1", text: "test", complete: false })
			db.commit(tx)

			expect(changes1).toEqual([
				[],
				[{ id: "1", text: "test", complete: false }],
			])
			expect(changes2).toEqual([
				[],
				[{ id: "1", text: "test", complete: false }],
			])

			sub1.destroy()
			sub2.destroy()
		})
	})

	describe("Transaction handling", () => {
		// TODO: Implement storage rollback
		test.skip("rolls back transactions that failed to store", async () => {
			// Setup initial state
			const tx = db.transact()
			tx.set("todos", { id: "1", text: "stable", complete: false })
			db.commit(tx)

			// Create failing storage
			const failingStorage: StorageApi = {
				async scan() {
					const results = await storage.scan()
					return results
				},
				async commit() {
					await Promise.reject(new Error("Simulated failure"))
				},
				close: () => Promise.resolve(),
				clear: () => Promise.resolve(),
			}

			const failingDb = new TandemClient<TodoSchema>({
				storage: failingStorage,
			})
			await failingDb.ready

			// Attempt complex transaction
			const failingTx = failingDb.transact()
			failingTx.set("todos", { id: "2", text: "new", complete: false })
			failingTx.set("todos", { id: "1", text: "modified", complete: true })
			failingDb.commit(failingTx)

			// Verify rollback
			expectDb(failingDb)
				.list("todos")
				.toEqual([{ id: "1", text: "stable", complete: false }])
		})

		test("handles concurrent transactions", () => {
			const tx1 = db.transact()
			const tx2 = db.transact()

			tx1.set("todos", { id: "1", text: "first", complete: false })
			tx2.set("todos", { id: "2", text: "second", complete: false })

			db.commit(tx1)
			db.commit(tx2)

			expectDb(db)
				.list("todos")
				.toEqual([
					{ id: "1", text: "first", complete: false },
					{ id: "2", text: "second", complete: false },
				])
		})
	})

	describe("Storage synchronization", () => {
		test("loads initial state correctly", async () => {
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
			const newDb = new TandemClient<TodoSchema>({ storage })
			await newDb.ready

			expectDb(newDb)
				.list("todos")
				.toEqual([{ id: "1", text: "existing", complete: false }])
		})

		test("handles delayed storage operations", async () => {
			const delayedStorage: StorageApi = {
				async scan() {
					await new Promise((resolve) => setTimeout(resolve, 100))
					return storage.scan()
				},
				async commit(ops: WriteOps) {
					await new Promise((resolve) => setTimeout(resolve, 100))
					return storage.commit(ops)
				},
				close: () => Promise.resolve(),
				clear: () => Promise.resolve(),
			}

			const slowDb = new TandemClient<TodoSchema>({ storage: delayedStorage })
			await slowDb.ready

			const tx = slowDb.transact()
			tx.set("todos", { id: "1", text: "slow", complete: false })
			slowDb.commit(tx)

			await expectDb(slowDb)
				.list("todos")
				.toEventuallyEqual([{ id: "1", text: "slow", complete: false }])
		})
	})

	describe("Error handling", () => {
		test("handles storage initialization failures", async () => {
			const failingStorage: StorageApi = {
				scan: () => Promise.reject(new Error("Scan failed")),
				commit: () => Promise.reject(new Error("Commit failed")),
				close: () => Promise.resolve(),
				clear: () => Promise.resolve(),
			}

			const failingDb = new TandemClient<TodoSchema>({
				storage: failingStorage,
			})
			await expect(failingDb.ready).toReject("Scan failed")
		})

		// TODO: Implement storage rollback
		test.skip("maintains consistency after failed operations", async () => {
			const commitMock = vi.fn((ops: WriteOps) => {
				return storage.commit(ops)
			})

			const intermittentStorage: StorageApi = {
				async scan() {
					return await storage.scan()
				},
				commit: commitMock,
				close: () => Promise.resolve(),
				clear: () => Promise.resolve(),
			}

			const db = new TandemClient<TodoSchema>({ storage: intermittentStorage })
			await db.ready

			// Successful operation
			const tx1 = db.transact()
			tx1.set("todos", { id: "1", text: "stable", complete: false })
			db.commit(tx1)

			// Failed operation
			commitMock.mockRejectedValueOnce(new Error("Mocked storage failure"))
			const tx2 = db.transact()
			tx2.set("todos", { id: "2", text: "should fail", complete: false })
			expect(() => db.commit(tx2)).toThrow("Mocked storage failure")

			// Verify state after failure
			await expectDb(db)
				.list("todos")
				.toEventuallyEqual([{ id: "1", text: "stable", complete: false }])

			// Verify can still perform operations
			const tx3 = db.transact()
			tx3.set("todos", { id: "3", text: "after failure", complete: false })
			db.commit(tx3)

			await expectDb(db)
				.list("todos")
				.toEventuallyEqual([
					{ id: "1", text: "stable", complete: false },
					{ id: "3", text: "after failure", complete: false },
				])
		})
	})

	describe("Remote", () => {
		const remoteTest = test.extend<{
			logger: LoggerApi
			remote: TestRemote<TodoSchema>
			db1: TandemClient<TodoSchema>
			db2: TandemClient<TodoSchema>
		}>({
			async logger({}, use) {
				await use(rootLogger)
			},

			async remote({ logger }, use) {
				const remote = new TestRemote<TodoSchema>({
					logger: logger.scope("remote"),
				})
				await use(remote)
			},

			async db1({ remote, logger }, use) {
				const db = new TandemClient<TodoSchema>({
					remote,
					logger: logger.scope("db1"),
				})
				await db.ready
				await use(db)
				await db.disconnect()
			},

			async db2({ remote, logger }, use) {
				const db = new TandemClient<TodoSchema>({
					remote,
					logger: logger.scope("db2"),
				})
				await db.ready
				await use(db)
				await db.disconnect()
			},
		})

		remoteTest(
			"syncs changes between databases",
			async ({ db1, db2, remote }) => {
				// Make a change in db1
				const tx = db1.transact()
				tx.set("todos", { id: "1", text: "test", complete: false })
				await db1.commit(tx)

				// Verify change was sent to remote
				expect(remote.getMutations()).toHaveLength(1)

				// Verify db2 received the change
				await expectDb(db2)
					.list("todos")
					.toEventuallyEqual([{ id: "1", text: "test", complete: false }])

				// Make a change in db2
				const tx2 = db2.transact()
				tx2.set("todos", { id: "1", text: "modified", complete: true })
				await db2.commit(tx2)

				// Verify both changes were sent to remote
				expect(remote.getMutations()).toHaveLength(2)

				// Verify db1 received the change
				await expectDb(db1)
					.list("todos")
					.toEventuallyEqual([{ id: "1", text: "modified", complete: true }])
			},
		)

		remoteTest(
			"works when second database connects after first one made a change",
			async ({ db1, remote, logger }) => {
				// Make a change in db1
				const tx = db1.transact()
				tx.set("todos", { id: "1", text: "test", complete: false })
				db1.commit(tx)

				const db2 = new TandemClient<TodoSchema>({
					remote,
					logger: logger.scope("db2"),
				})
				await db2.ready

				// Verify change was received
				await expectDb(db2)
					.list("todos")
					.toEventuallyEqual([{ id: "1", text: "test", complete: false }])
			},
		)

		remoteTest(
			"Works when second database connects after first one made many changes",
			async ({ db1, db2 }) => {
				// Make multiple changes in first database
				const tx1 = db1.transact()
				for (let i = 0; i < 100; i++) {
					tx1.set("todos", {
						id: `task-${i}`,
						text: `Task ${i}`,
						complete: i % 2 === 0,
					})
				}
				db1.commit(tx1)

				// Delete some items
				const tx2 = db1.transact()
				for (let i = 0; i < 50; i++) {
					tx2.remove("todos", `task-${i}`)
				}
				db1.commit(tx2)

				// Verify second database has correct final state
				await expectDb(db2)
					.list("todos")
					.toEventuallyEqual(
						Array.from({ length: 50 }, (_, i) => i + 50).map((i) => ({
							id: `task-${i}`,
							text: `Task ${i}`,
							complete: i % 2 === 0,
						})),
					)
			},
		)

		remoteTest(
			"Applies speculative mutations for us on top of pulled changes",
			async ({ db1, db2 }) => {
				// db1 makes a change
				// Wait for remote to receive the change (but don't resolve it yet)
				// db1 makes another change
				// Remote resolves the change
				// Expect both changes to have been applied locally

				// db1 makes a change and it syncs
				const tx1 = db1.transact()
				tx1.set("todos", { id: "1", text: "original", complete: false })
				db1.commit(tx1)

				// db1 disconnects
				await db2.disconnect()
				// db1 makes some changes and sends
				const tx2 = db1.transact()
				tx2.set("todos", { id: "2", text: "speculative", complete: true })
				db1.commit(tx2)

				// remote queues for db2
				// db2 makes a local transaction to `done` a task
				const tx3 = db2.transact()
				tx3.set("todos", { id: "1", text: "original", complete: true })
				db2.commit(tx3)

				// db2 reconnects
				await db2.connect()

				// db2 pulls the new changes from db1 and its speculative mutation still happened
				await expectDb(db2)
					.list("todos")
					.toEventuallyEqual([
						{ id: "1", text: "original", complete: true },
						{ id: "2", text: "speculative", complete: true },
					])
			},
		)

		remoteTest(
			"Applies speculative mutations for them on top of pulled changes",
			async ({ db1, db2 }) => {
				// db1 makes a change
				// Wait for remote to receive the change (but don't resolve it yet)
				// db1 makes another change

				// db1 makes a change and it syncs
				const tx1 = db1.transact()
				tx1.set("todos", { id: "1", text: "original", complete: false })
				db1.commit(tx1)

				// db1 disconnects
				await db2.disconnect()
				// db1 makes some changes and sends
				const tx2 = db1.transact()
				tx2.set("todos", { id: "2", text: "speculative", complete: true })
				db1.commit(tx2)

				// remote queues for db2
				// db2 makes a local transaction to `done` a task
				const tx3 = db2.transact()
				tx3.set("todos", { id: "1", text: "original", complete: true })
				db2.commit(tx3)

				// db2 reconnects
				await db2.connect()

				// db2 pulls the new changes from db1 and its speculative mutation still happened
				await expectDb(db2)
					.list("todos")
					.toEventuallyEqual([
						{ id: "1", text: "original", complete: true },
						{ id: "2", text: "speculative", complete: true },
					])
			},
		)

		test.todo("Database mounted after syncing is ready")

		remoteTest(
			"Changes in scan window are reflected in results",
			async ({ db1, db2 }) => {
				// db1 makes a change
				const tx = db1.transact()
				tx.set("todos", { id: "1", text: "test", complete: false })
				db1.commit(tx)

				// db2 makes a change
				const tx2 = db2.transact()
				tx2.set("todos", { id: "2", text: "test", complete: false })
				db2.commit(tx2)

				// Verify db2 has the change
				await expectDb(db2)
					.list("todos")
					.toEventuallyEqual([
						{ id: "1", text: "test", complete: false },
						{ id: "2", text: "test", complete: false },
					])
			},
		)
		remoteTest(
			"Changes outside of scan window are not reflected in results",
			async ({ db1, db2 }) => {
				// db1 makes a change
				const tx = db1.transact()
				tx.set("todos", { id: "1", text: "test", complete: false })
				db1.commit(tx)

				// db2 makes a change
				const tx2 = db2.transact()
				tx2.set("lists", { id: "1", name: "test" })
				db2.commit(tx2)

				// Verify db2 doesn't have the change
				expectDb(db2).list("todos").toEqual([])

				// Verify db2 eventually gets the change once we start listening
				await expectDb(db2)
					.list("lists")
					.toEventuallyEqual([{ id: "1", name: "test" }])
			},
		)
	})
})
