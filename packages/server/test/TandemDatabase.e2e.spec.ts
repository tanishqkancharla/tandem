import { describe, expect, test, vi } from "vitest"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
	createGatedPushRemote,
	openTursoFixture,
	project,
	task,
	type TaskRecord,
	type TursoFixture,
} from "./tandemDatabaseFixture"

const unfinishedTasksQuery = {
	collection: "tasks",
	where: { done: false },
	orderBy: { title: "asc" },
} as const

const allTasksByTitleQuery = {
	collection: "tasks",
	orderBy: { title: "asc" },
} as const

const allTasksByIdQuery = {
	collection: "tasks",
	orderBy: { id: "asc" },
} as const

async function withFixture(
	run: (fixture: TursoFixture) => Promise<void>,
	options?: Parameters<typeof openTursoFixture>[0],
) {
	const fixture = await openTursoFixture(options)
	try {
		await run(fixture)
	} finally {
		await fixture.close()
	}
}

describe("TandemDatabase", () => {
	test("server transaction removes a completed task from subscribed views", async () => {
		await withFixture(async (fixture) => {
			const { database } = fixture
			const subscriptions: { destroy: () => void }[] = []
			let observedA: TaskRecord[] = []
			let observedB: TaskRecord[] = []

			try {
				const seedTx = database.transact()
				seedTx.set("tasks", task("a", "Alpha"))
				seedTx.set("tasks", task("b", "Beta"))
				await database.commit(seedTx)

				const clientA = await fixture.connectClient({ label: "view-a" })
				const clientB = await fixture.connectClient({ label: "view-b" })
				subscriptions.push(
					clientA.subscribe(unfinishedTasksQuery, (rows) => {
						observedA = rows
					}),
					clientB.subscribe(unfinishedTasksQuery, (rows) => {
						observedB = rows
					}),
				)
				await Promise.all([clientA.pullFromRemote(), clientB.pullFromRemote()])
				await vi.waitFor(() => {
					expect(observedA).toEqual([task("a", "Alpha"), task("b", "Beta")])
					expect(observedB).toEqual([task("a", "Alpha"), task("b", "Beta")])
				})

				// A server commit persists completion and updates both existing views.
				const tx = database.transact()
				tx.update("tasks", "a", (row) => ({ ...row, done: true }))
				await database.commit(tx)

				expect(
					await database.query({ collection: "tasks", where: { id: "a" } }),
				).toEqual([{ ...task("a", "Alpha"), done: true }])
				await vi.waitFor(() => {
					expect(observedA).toEqual([task("b", "Beta")])
					expect(observedB).toEqual([task("b", "Beta")])
				})
			} finally {
				for (const subscription of subscriptions) subscription.destroy()
			}
		})
	})

	test("view transaction becomes visible to direct queries and another subscriber", async () => {
		await withFixture(async (fixture) => {
			const { database } = fixture
			const subscriptions: { destroy: () => void }[] = []
			let observedA: TaskRecord[] = []
			let observedB: TaskRecord[] = []

			try {
				const clientA = await fixture.connectClient({ label: "author" })
				const clientB = await fixture.connectClient({ label: "observer" })
				subscriptions.push(
					clientA.subscribe(allTasksByTitleQuery, (rows) => {
						observedA = rows
					}),
					clientB.subscribe(allTasksByTitleQuery, (rows) => {
						observedB = rows
					}),
				)
				await Promise.all([clientA.pullFromRemote(), clientB.pullFromRemote()])
				await vi.waitFor(() => {
					expect(observedA).toEqual([])
					expect(observedB).toEqual([])
				})

				// A view commit is visible to authoritative queries and the other view.
				const tx = clientA.transact()
				tx.set("tasks", task("c", "Gamma"))
				await clientA.commit(tx)

				expect(await database.query(allTasksByTitleQuery)).toEqual([
					task("c", "Gamma"),
				])
				await vi.waitFor(() => {
					expect(observedB).toEqual([task("c", "Gamma")])
				})
			} finally {
				for (const subscription of subscriptions) subscription.destroy()
			}
		})
	})

	test("direct query filters and projects persisted related records without a sync client", async () => {
		await withFixture(async ({ database }) => {
			const seedTx = database.transact()
			seedTx.set("projects", project("p1", "Work"))
			seedTx.set("projects", project("p2", "Home"))
			seedTx.set("tasks", task("a", "Alpha", { priority: 3, projectId: "p1" }))
			seedTx.set("tasks", task("b", "Beta", { priority: 2, projectId: "p2" }))
			seedTx.set("tasks", task("c", "Gamma", { priority: 1, projectId: "p1" }))
			seedTx.set(
				"tasks",
				task("d", "Delta", { done: true, priority: 4, projectId: "p1" }),
			)
			seedTx.set("tasks", task("e", "Epsilon", { priority: 0 }))
			await database.commit(seedTx)

			expect(
				await database.query({
					collection: "tasks",
					where: { done: false },
					orderBy: { priority: "desc" },
					offset: 1,
					limit: 2,
					select: { id: true, title: true, projectId: true },
					with: { project: { select: { name: true } } },
				}),
			).toEqual([
				{
					id: "b",
					title: "Beta",
					projectId: "p2",
					project: { name: "Home" },
				},
				{
					id: "c",
					title: "Gamma",
					projectId: "p1",
					project: { name: "Work" },
				},
			])

			// A missing optional relation uses Tandem's null many-to-one result.
			expect(
				await database.query({
					collection: "tasks",
					where: { id: "e" },
					with: { project: true },
				}),
			).toEqual([{ ...task("e", "Epsilon", { priority: 0 }), project: null }])
		})
	})

	test("direct transaction updates and removes existing rows without replica preloading", async () => {
		await withFixture(async ({ database }) => {
			const seedTx = database.transact()
			seedTx.set("tasks", task("a", "Alpha"))
			seedTx.set("tasks", task("b", "Beta"))
			await database.commit(seedTx)

			const tx = database.transact()
			tx.update("tasks", "a", (row) => ({ ...row, title: "Alpha updated" }))
			tx.remove("tasks", "b")
			tx.set("tasks", task("c", "Gamma"))
			tx.update("tasks", "c", (row) => ({ ...row, priority: 7 }))
			tx.update("tasks", "missing", (row) => ({ ...row, title: "nope" }))

			// Transaction reads observe earlier writes in this transaction.
			expect(await tx.get("tasks", "c")).toEqual(
				task("c", "Gamma", { priority: 7 }),
			)
			expect(await tx.get("tasks", "b")).toBeUndefined()
			expect(await tx.get("tasks", "missing")).toBeUndefined()

			await database.commit(tx)

			expect(await database.query(allTasksByTitleQuery)).toEqual([
				task("a", "Alpha updated"),
				task("c", "Gamma", { priority: 7 }),
			])
		})
	})

	test("cancel discards a direct transaction without publishing it", async () => {
		await withFixture(async (fixture) => {
			const { database } = fixture
			const observed: TaskRecord[][] = []
			let latest: TaskRecord[] = []
			const subscriptions: { destroy: () => void }[] = []

			try {
				const seedTx = database.transact()
				seedTx.set("tasks", task("a", "Alpha"))
				await database.commit(seedTx)

				const client = await fixture.connectClient({ label: "cancel-view" })
				subscriptions.push(
					client.subscribe(allTasksByTitleQuery, (rows) => {
						latest = rows
						observed.push(rows)
					}),
				)
				await client.pullFromRemote()
				await vi.waitFor(() => {
					expect(latest).toEqual([task("a", "Alpha")])
				})
				const afterInitial = observed.length

				const cancelTx = database.transact()
				cancelTx.remove("tasks", "a")
				cancelTx.set("tasks", task("b", "Beta"))
				cancelTx.cancel()

				// A later successful write is the positive propagation checkpoint.
				const tx = database.transact()
				tx.set("tasks", task("c", "Gamma"))
				await database.commit(tx)

				await vi.waitFor(() => {
					expect(latest).toEqual([task("a", "Alpha"), task("c", "Gamma")])
				})
				expect(await database.query(allTasksByTitleQuery)).toEqual([
					task("a", "Alpha"),
					task("c", "Gamma"),
				])
				expect(
					observed
						.slice(afterInitial)
						.every(
							(rows) =>
								rows.some((row) => row.id === "a") &&
								rows.every((row) => row.id !== "b"),
						),
				).toBe(true)
			} finally {
				for (const subscription of subscriptions) subscription.destroy()
			}
		})
	})

	test("failed transaction preserves prior rows and does not publish partial writes", async () => {
		await withFixture(async (fixture) => {
			const { database } = fixture
			const observed: TaskRecord[][] = []
			let latest: TaskRecord[] = []
			const subscriptions: { destroy: () => void }[] = []

			try {
				const seedTx = database.transact()
				seedTx.set("tasks", task("a", "Alpha"))
				seedTx.set("tasks", task("r", "Reserved"))
				await database.commit(seedTx)

				const client = await fixture.connectClient({ label: "rollback-view" })
				subscriptions.push(
					client.subscribe(allTasksByTitleQuery, (rows) => {
						latest = rows
						observed.push(rows)
					}),
				)
				await client.pullFromRemote()
				await vi.waitFor(() => {
					expect(latest).toEqual([task("a", "Alpha"), task("r", "Reserved")])
				})
				const afterInitial = observed.length

				const failedTx = database.transact()
				failedTx.update("tasks", "a", (row) => ({
					...row,
					title: "Changed",
				}))
				failedTx.set("tasks", task("x", "Reserved"))
				await expect(database.commit(failedTx)).rejects.toThrow()

				const tx = database.transact()
				tx.set("tasks", task("c", "Gamma"))
				await database.commit(tx)

				await vi.waitFor(() => {
					expect(latest).toEqual([
						task("a", "Alpha"),
						task("c", "Gamma"),
						task("r", "Reserved"),
					])
				})
				expect(await database.query(allTasksByTitleQuery)).toEqual([
					task("a", "Alpha"),
					task("c", "Gamma"),
					task("r", "Reserved"),
				])
				expect(
					observed
						.slice(afterInitial)
						.every((rows) =>
							rows.every((row) => row.title !== "Changed" && row.id !== "x"),
						),
				).toBe(true)
			} finally {
				for (const subscription of subscriptions) subscription.destroy()
			}
		})
	})

	test("server commit does not acknowledge or discard another client's pending transaction", async () => {
		await withFixture(async (fixture) => {
			const { database } = fixture
			const gate = createGatedPushRemote(database)
			const subscriptions: { destroy: () => void }[] = []
			let observedA: TaskRecord[] = []
			let observedB: TaskRecord[] = []

			try {
				const seedTx = database.transact()
				seedTx.set("tasks", task("a", "Alpha"))
				seedTx.set("tasks", task("b", "Beta"))
				await database.commit(seedTx)

				const clientA = await fixture.connectClient({
					label: "pending-author",
					remote: gate.remote,
				})
				const clientB = await fixture.connectClient({
					label: "pending-observer",
				})
				subscriptions.push(
					clientA.subscribe(allTasksByIdQuery, (rows) => {
						observedA = rows
					}),
					clientB.subscribe(allTasksByIdQuery, (rows) => {
						observedB = rows
					}),
				)
				await Promise.all([clientA.pullFromRemote(), clientB.pullFromRemote()])
				await vi.waitFor(() => {
					expect(observedA).toEqual([task("a", "Alpha"), task("b", "Beta")])
					expect(observedB).toEqual([task("a", "Alpha"), task("b", "Beta")])
				})

				gate.arm()
				const pendingTx = clientA.transact()
				pendingTx.update("tasks", "a", (row) => ({
					...row,
					title: "Local Alpha",
				}))
				const pendingCommit = clientA.commit(pendingTx)
				await gate.waitForGate()

				// A's push is held at the RemoteApi boundary. Completing Beta on the
				// server must still reach A through normal sync without acknowledging
				// A's pending rename.
				const tx = database.transact()
				tx.update("tasks", "b", (row) => ({ ...row, done: true }))
				await database.commit(tx)

				await vi.waitFor(() => {
					expect(observedA).toEqual([
						task("a", "Local Alpha"),
						{ ...task("b", "Beta"), done: true },
					])
				})
				expect(
					await database.query({ collection: "tasks", where: { id: "a" } }),
				).toEqual([task("a", "Alpha")])

				gate.release()
				await pendingCommit

				await vi.waitFor(() => {
					expect(observedB).toEqual([
						task("a", "Local Alpha"),
						{ ...task("b", "Beta"), done: true },
					])
				})
				expect(await database.query(allTasksByIdQuery)).toEqual([
					task("a", "Local Alpha"),
					{ ...task("b", "Beta"), done: true },
				])
			} finally {
				gate.release()
				for (const subscription of subscriptions) subscription.destroy()
			}
		})
	})

	test("committed data survives reopen for direct and fresh sync consumers", async () => {
		const dir = await mkdtemp(join(tmpdir(), "tandem-turso-reopen-"))
		const filePath = join(dir, "tandem.db")

		try {
			const fixture = await openTursoFixture({ filePath })
			try {
				const { database } = fixture
				const seedTx = database.transact()
				seedTx.set("tasks", task("a", "Alpha"))
				await database.commit(seedTx)

				const client = await fixture.connectClient({ label: "writer" })
				const tx = client.transact()
				tx.set("tasks", task("b", "Beta"))
				await client.commit(tx)
				expect(await database.query(allTasksByTitleQuery)).toEqual([
					task("a", "Alpha"),
					task("b", "Beta"),
				])
			} finally {
				await fixture.close()
			}

			const reopened = await openTursoFixture({
				filePath,
				createTables: false,
			})
			const subscriptions: { destroy: () => void }[] = []
			let latest: TaskRecord[] = []
			try {
				expect(await reopened.database.query(allTasksByTitleQuery)).toEqual([
					task("a", "Alpha"),
					task("b", "Beta"),
				])

				const client = await reopened.connectClient({ label: "reopened-view" })
				subscriptions.push(
					client.subscribe(unfinishedTasksQuery, (rows) => {
						latest = rows
					}),
				)
				await client.pullFromRemote()
				await vi.waitFor(() => {
					expect(latest).toEqual([task("a", "Alpha"), task("b", "Beta")])
				})

				const tx = reopened.database.transact()
				tx.update("tasks", "a", (row) => ({ ...row, done: true }))
				await reopened.database.commit(tx)
				await vi.waitFor(() => {
					expect(latest).toEqual([task("b", "Beta")])
				})
			} finally {
				for (const subscription of subscriptions) subscription.destroy()
				await reopened.close()
			}
		} finally {
			await rm(dir, { recursive: true, force: true })
		}
	})

	test("concurrent direct and sync commits converge on all distinct records", async () => {
		await withFixture(async (fixture) => {
			const { database } = fixture
			const subscriptions: { destroy: () => void }[] = []
			let latest: TaskRecord[] = []

			try {
				const client = await fixture.connectClient({ label: "writer" })
				const observer = await fixture.connectClient({ label: "observer" })
				subscriptions.push(
					observer.subscribe(allTasksByTitleQuery, (rows) => {
						latest = rows
					}),
				)
				await observer.pullFromRemote()
				await vi.waitFor(() => {
					expect(latest).toEqual([])
				})

				const alphaTx = database.transact()
				alphaTx.set("tasks", task("a", "Alpha"))
				const betaTx = database.transact()
				betaTx.set("tasks", task("b", "Beta"))
				const gammaTx = client.transact()
				gammaTx.set("tasks", task("c", "Gamma"))

				await Promise.all([
					database.commit(alphaTx),
					database.commit(betaTx),
					client.commit(gammaTx),
				])

				expect(await database.query(allTasksByTitleQuery)).toEqual([
					task("a", "Alpha"),
					task("b", "Beta"),
					task("c", "Gamma"),
				])
				await vi.waitFor(() => {
					expect(latest).toEqual([
						task("a", "Alpha"),
						task("b", "Beta"),
						task("c", "Gamma"),
					])
				})
			} finally {
				for (const subscription of subscriptions) subscription.destroy()
			}
		})
	})
})
