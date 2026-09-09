import { expect } from "vitest"
import { expectQuery, project, task, test } from "./tandemDatabaseFixture"

const unfinishedTasks = {
	collection: "tasks",
	where: { done: false },
	orderBy: { title: "asc" },
} as const

const allTasksByTitle = {
	collection: "tasks",
	orderBy: { title: "asc" },
} as const

test("direct and replica commits are visible to each other", async ({
	database,
	makeClient,
}) => {
	const seedTx = database.transact()
	seedTx.set("tasks", task("a", "Alpha"))
	seedTx.set("tasks", task("b", "Beta"))
	await database.commit(seedTx)

	const client = await makeClient()
	client.subscribe(unfinishedTasks)
	await expectQuery(client, unfinishedTasks).toResolveTo([
		task("a", "Alpha"),
		task("b", "Beta"),
	])

	const replicaTx = client.transact()
	replicaTx.set("tasks", task("c", "Gamma"))
	await client.commit(replicaTx)
	expect(await database.query(allTasksByTitle)).toEqual([
		task("a", "Alpha"),
		task("b", "Beta"),
		task("c", "Gamma"),
	])

	const tx = database.transact()
	tx.update("tasks", "a", (row) => ({ ...row, done: true }))
	await database.commit(tx)
	await expectQuery(client, unfinishedTasks).toResolveTo([
		task("b", "Beta"),
		task("c", "Gamma"),
	])
})

test("direct query filters and projects persisted related records without a sync client", async ({
	database,
}) => {
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

test("direct transaction updates and removes existing rows without replica preloading", async ({
	database,
}) => {
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

	expect(await database.query(allTasksByTitle)).toEqual([
		task("a", "Alpha updated"),
		task("c", "Gamma", { priority: 7 }),
	])
})

test("cancel discards a direct transaction without publishing it", async ({
	database,
}) => {
	const seedTx = database.transact()
	seedTx.set("tasks", task("a", "Alpha"))
	await database.commit(seedTx)

	const cancelTx = database.transact()
	cancelTx.remove("tasks", "a")
	cancelTx.set("tasks", task("b", "Beta"))
	cancelTx.cancel()

	expect(await database.query(allTasksByTitle)).toEqual([task("a", "Alpha")])
})

test("failed transaction preserves prior rows and does not publish partial writes", async ({
	database,
}) => {
	const seedTx = database.transact()
	seedTx.set("tasks", task("a", "Alpha"))
	seedTx.set("tasks", task("r", "Reserved"))
	await database.commit(seedTx)

	const failedTx = database.transact()
	failedTx.update("tasks", "a", (row) => ({ ...row, title: "Changed" }))
	failedTx.set("tasks", task("x", "Reserved"))
	await expect(database.commit(failedTx)).rejects.toThrow()

	expect(await database.query(allTasksByTitle)).toEqual([
		task("a", "Alpha"),
		task("r", "Reserved"),
	])
})

test("server commit does not acknowledge or discard another client's pending transaction", async ({
	database,
	makeClient,
	makePushGate,
}) => {
	const seedTx = database.transact()
	seedTx.set("tasks", task("a", "Alpha"))
	seedTx.set("tasks", task("b", "Beta"))
	await database.commit(seedTx)

	const gate = makePushGate()
	const client = await makeClient({ remote: gate.remote })
	client.subscribe(allTasksByTitle)
	await expectQuery(client, allTasksByTitle).toResolveTo([
		task("a", "Alpha"),
		task("b", "Beta"),
	])

	gate.hold()
	const pendingTx = client.transact()
	pendingTx.update("tasks", "a", (row) => ({
		...row,
		title: "Local Alpha",
	}))
	const pendingCommit = client.commit(pendingTx)
	await gate.waitUntilHeld()

	const tx = database.transact()
	tx.update("tasks", "b", (row) => ({ ...row, done: true }))
	await database.commit(tx)

	await expectQuery(client, allTasksByTitle).toResolveTo([
		task("a", "Local Alpha"),
		{ ...task("b", "Beta"), done: true },
	])
	expect(
		await database.query({ collection: "tasks", where: { id: "a" } }),
	).toEqual([task("a", "Alpha")])

	gate.allow()
	await pendingCommit

	expect(await database.query(allTasksByTitle)).toEqual([
		task("a", "Local Alpha"),
		{ ...task("b", "Beta"), done: true },
	])
})

test("committed data survives reopen", async ({ openDatabase }) => {
	const first = await openDatabase()
	const seedTx = first.database.transact()
	seedTx.set("tasks", task("a", "Alpha"))
	await first.database.commit(seedTx)
	await first.close()

	const reopened = await openDatabase({
		filePath: first.filePath,
		createTables: false,
	})
	expect(await reopened.database.query(allTasksByTitle)).toEqual([
		task("a", "Alpha"),
	])
})

test("concurrent direct and sync commits converge on all distinct records", async ({
	database,
	makeClient,
}) => {
	const client = await makeClient()

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

	expect(await database.query(allTasksByTitle)).toEqual([
		task("a", "Alpha"),
		task("b", "Beta"),
		task("c", "Gamma"),
	])
})
