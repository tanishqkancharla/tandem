import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { collection, defineSchema } from "@tanishqkancharla/tandem-core"
import { expect, test as baseTest } from "vitest"
import { TandemServer, TandemServerJsonFileStorage } from "../src"

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
