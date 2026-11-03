import { collection, defineSchema, tag } from "@tanishqkancharla/tandem-core"
import type {
	ClientId,
	Mutation,
	MutationId,
	ScanWindow,
} from "@tanishqkancharla/tandem-core"
import { TandemServer } from "@tanishqkancharla/tandem-server"
import { assert, expect } from "vitest"
import { TandemServerPostgresStorage } from "../src/index.js"
import { test } from "./postgres.fixture.js"

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

const scanWindow: ScanWindow<TodoSchema> = [{ collection: "todos" }]

function createServer(connectionString: string) {
	const storage = new TandemServerPostgresStorage<TodoSchema>({
		connectionString,
	})
	return new TandemServer({ schema, relations: {}, storage })
}

function setTodo(id: number, value: Todo): Mutation<TodoSchema> {
	return {
		id: tag<MutationId>(id),
		ops: [{ type: "set", collection: "todos", value }],
	}
}

test("persists TandemServer transactions across server restarts", async ({
	databaseUrl,
}) => {
	const first = createServer(databaseUrl)
	const create = first.transact()
	create.set("todos", { id: "todo-1", title: "Ship", completed: false })
	await first.commit(create)
	await first.close()

	const second = createServer(databaseUrl)
	const complete = second.transact()
	await complete.update("todos", "todo-1", { completed: true })
	await second.commit(complete)
	await second.close()

	const third = createServer(databaseUrl)
	expect(await third.query({ collection: "todos" })).toEqual([
		{ id: "todo-1", title: "Ship", completed: true },
	])
	await third.close()
})

test("pushes acknowledge, poke other clients, and pull back", async ({
	databaseUrl,
}) => {
	const server = createServer(databaseUrl)
	const writer = tag<ClientId>("writer")
	const reader = tag<ClientId>("reader")
	const before = await server.pull({ clientId: reader, scanWindow })
	assert(!("error" in before))
	const poked = Promise.withResolvers<void>()
	await server.connect({
		clientId: reader,
		poke: () => {
			poked.resolve()
			return Promise.resolve()
		},
	})

	await server.push({
		clientId: writer,
		mutations: [setTodo(1, { id: "todo-1", title: "Write", completed: false })],
	})
	await poked.promise
	expect(
		await server.pull({ clientId: reader, scanWindow, cookie: before.cookie }),
	).toMatchObject({
		patch: {
			set: [
				{
					collection: "todos",
					value: { id: "todo-1", title: "Write", completed: false },
				},
			],
			remove: [],
		},
	})

	// A server restart keeps the writer's acknowledgement, so a retry is skipped.
	await server.close()
	const restarted = createServer(databaseUrl)
	await restarted.push({
		clientId: writer,
		mutations: [
			setTodo(1, { id: "todo-1", title: "Retried", completed: true }),
		],
	})
	expect(await restarted.pull({ clientId: writer, scanWindow })).toMatchObject({
		lastMutationId: 1,
		patch: {
			set: [
				{
					collection: "todos",
					value: { id: "todo-1", title: "Write", completed: false },
				},
			],
		},
	})
	await restarted.close()
})

test("a push to one server pokes clients of another server on the same database", async ({
	databaseUrl,
}) => {
	const first = createServer(databaseUrl)
	// Wait until the second server's storage listens, so the poke below comes
	// from the first server's write rather than from listening starting.
	const storage = new TandemServerPostgresStorage<TodoSchema>({
		connectionString: databaseUrl,
	})
	const listening = Promise.withResolvers<void>()
	const stopListening = storage.subscribe(listening.resolve)
	await listening.promise
	const second = new TandemServer({ schema, relations: {}, storage })
	stopListening()

	const clientId = tag<ClientId>("second-server-client")
	const before = await second.pull({ clientId, scanWindow })
	assert(!("error" in before))
	const poked = Promise.withResolvers<void>()
	await second.connect({
		clientId,
		poke: () => {
			poked.resolve()
			return Promise.resolve()
		},
	})

	await first.push({
		clientId: tag<ClientId>("first-server-client"),
		mutations: [
			setTodo(1, { id: "todo-1", title: "From first", completed: false }),
		],
	})
	await poked.promise
	expect(
		await second.pull({ clientId, scanWindow, cookie: before.cookie }),
	).toMatchObject({
		patch: {
			set: [
				{
					collection: "todos",
					value: { id: "todo-1", title: "From first", completed: false },
				},
			],
			remove: [],
		},
	})
	await first.close()
	await second.close()
})
