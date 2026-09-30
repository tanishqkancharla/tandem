import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { collection, defineSchema, tag } from "@tanishqkancharla/tandem-core"
import type {
	ClientId,
	Mutation,
	MutationId,
	ScanWindow,
} from "@tanishqkancharla/tandem-core"
import { expect, test as baseTest } from "vitest"
import { TandemServer, TandemServerJsonFileStorage } from "../src/index.js"

type Todo = {
	id: string
	title: string
	completed: boolean
}

type TodoSchema = {
	todos: Todo
}

const schema = defineSchema({
	todos: collection<Todo>({ fields: ["id", "title", "completed"] }),
})

const test = baseTest.extend<{ filePath: string }>({
	filePath: async ({}, use) => {
		const directory = await fs.mkdtemp(
			path.join(os.tmpdir(), "tandem-server-json-storage-"),
		)
		await use(path.join(directory, "nested", "tandem.json"))
		await fs.rm(directory, { recursive: true, force: true })
	},
})

function createServer(filePath: string) {
	const storage = new TandemServerJsonFileStorage<TodoSchema>({ filePath })
	return new TandemServer({ schema, relations: {}, storage })
}

test("persists TandemServer transactions across storage instances", async ({
	filePath,
}) => {
	const firstServer = createServer(filePath)
	const create = firstServer.transact()
	create.set("todos", {
		id: "todo-1",
		title: "Ship TandemServer",
		completed: false,
	})
	await firstServer.commit(create)
	await firstServer.close()

	const secondServer = createServer(filePath)
	expect(await secondServer.query({ collection: "todos" })).toEqual([
		{
			id: "todo-1",
			title: "Ship TandemServer",
			completed: false,
		},
	])

	const complete = secondServer.transact()
	await complete.update("todos", "todo-1", (todo) => ({
		...todo,
		completed: true,
	}))
	await secondServer.commit(complete)
	await secondServer.close()

	const thirdServer = createServer(filePath)
	expect(await thirdServer.query({ collection: "todos" })).toEqual([
		{
			id: "todo-1",
			title: "Ship TandemServer",
			completed: true,
		},
	])
	await thirdServer.close()
})

test("reopened servers acknowledge retries without overwriting another client's edit", async ({
	filePath,
}) => {
	const clientId = tag<ClientId>("retry-client")
	const otherClientId = tag<ClientId>("other-client")
	const scanWindow: ScanWindow<TodoSchema> = [{ collection: "todos" }]
	const mutations: Mutation<TodoSchema>[] = [
		{
			id: tag<MutationId>(1),
			ops: [
				{
					type: "set",
					collection: "todos",
					value: { id: "todo-1", title: "Original", completed: false },
				},
			],
		},
	]
	const first = createServer(filePath)
	await first.push({ clientId, mutations })
	await first.push({
		clientId: otherClientId,
		mutations: [
			{
				id: tag<MutationId>(1),
				ops: [
					{
						type: "set",
						collection: "todos",
						value: { id: "todo-1", title: "Newer edit", completed: true },
					},
				],
			},
		],
	})
	await first.close()

	const reopened = createServer(filePath)
	const before = await reopened.pull({ clientId, scanWindow })
	let pokes = 0
	await reopened.connect({
		clientId,
		poke: () => {
			pokes += 1
			return Promise.resolve()
		},
	})
	await reopened.push({ clientId, mutations })
	expect(before.lastMutationId).toBe(1)
	expect(
		await reopened.pull({ clientId, scanWindow, cookie: before.cookie }),
	).toEqual({
		cookie: before.cookie,
		lastMutationId: 1,
		patch: { set: [], remove: [] },
	})
	expect(await reopened.query({ collection: "todos" })).toEqual([
		{ id: "todo-1", title: "Newer edit", completed: true },
	])
	expect(pokes).toBe(0)
	await reopened.close()
})

test("rejects malformed storage files at the adapter boundary", async ({
	filePath,
}) => {
	await fs.mkdir(path.dirname(filePath), { recursive: true })
	await fs.writeFile(filePath, "not json")
	const storage = new TandemServerJsonFileStorage<TodoSchema>({ filePath })

	await expect(storage.scan()).rejects.toThrow(
		`Tandem server JSON storage failed to parse ${filePath}`,
	)
})
