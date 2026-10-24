import {
	collection,
	defineMutators,
	defineSchema,
	Logger,
	MutationRejectedError,
	type RemoteApi,
	TandemClient,
	type TandemClientStorageApi,
	type TandemClientTuple,
} from "@tanishqkancharla/tandem-core"
import * as errore from "errore"
import { InMemoryTupleStorage } from "tuple-database"
import type { ScanStorageArgs, WriteOps } from "tuple-database"
import { expect, test as baseTest, vi } from "vitest"
import { TandemServer, type TandemServerPushOptions } from "../src/index.js"
import { TestTandemServerStorage } from "./TandemServerStorage.fixture.js"

type Todo = { id: string; text: string; done: boolean; author: string }
type TodoSchema = { todos: Todo }

const schema = defineSchema({
	todos: collection<Todo>({ fields: ["id", "text", "done", "author"] }),
})

const isAddTodoArgs = (input: unknown): input is { id: string; text: string } =>
	typeof input === "object" &&
	input !== null &&
	"id" in input &&
	typeof input.id === "string" &&
	"text" in input &&
	typeof input.text === "string"

/** Shared by client and server. The client does not know the author yet. */
const todoMutators = defineMutators(schema, {
	addTodo: {
		args: (input: unknown) => {
			if (!isAddTodoArgs(input)) throw new Error("Expected an id and text")
			return input
		},
		run: (tx, { id, text }) => {
			tx.set("todos", { id, text, done: false, author: "you" })
		},
	},
	toggleTodo: {
		args: (input: unknown) => input as { id: string },
		run: async (tx, { id }) => {
			const todo = await tx.get("todos", id)
			if (!todo) throw new Error(`No todo ${id}`)
			await tx.update("todos", id, { done: !todo.done })
		},
	},
})

type TodoServer = TandemServer<TodoSchema, {}>

class TodoBackend {
	readonly storage = new TestTandemServerStorage<TodoSchema>()
	readonly tandem: TodoServer = new TandemServer({
		schema,
		relations: {},
		storage: this.storage,
	})
	/** The signed-in user each push runs as. */
	user: string | undefined = "ada"
	/** Ids of todos whose `after` effect ran, in order. */
	readonly announced: string[] = []
	/** Unset, a push with mutators refuses generic operations. */
	allowOps: boolean | undefined = undefined
	/** The addTodo override runs a malformed query, as a bug in it would. */
	queryBug = false
	/** Mutators an older server deploy still lacks. */
	missing: (keyof typeof todoMutators)[] = []
	/** The next push response is lost after the server applies it. */
	loseNextResponse = false

	private pushOptions(): TandemServerPushOptions<TodoSchema, {}> {
		const user = this.user
		const mutators = this.tandem.serverMutators(todoMutators, {
			addTodo: async (tx, { id, text }, ctx) => {
				if (!user) throw new Error("Sign in to add todos")
				if (this.queryBug)
					await tx.query({
						collection: "todos",
						where: { done: { $bogus: true } } as never,
					})
				if (await tx.get("todos", id)) throw new Error(`Todo ${id} exists`)
				tx.set("todos", { id, text, done: false, author: user })
				ctx.after(() => this.announced.push(id))
			},
		})
		for (const name of this.missing) delete mutators[name]
		return { mutators, allowOps: this.allowOps }
	}

	remote(): RemoteApi<TodoSchema> {
		return {
			connect: (client) => this.tandem.connect(client),
			push: async (args) => {
				const response = await this.tandem.push(args, this.pushOptions())
				if (!this.loseNextResponse) return response
				this.loseNextResponse = false
				return { error: "unavailable", message: "Response lost" }
			},
			pull: (args) => this.tandem.pull(args),
		}
	}

	todos() {
		return this.tandem.query({ collection: "todos" })
	}
}

/** Client storage that outlives the client, as IndexedDB would. */
class MemoryClientStorage implements TandemClientStorageApi<TodoSchema> {
	private readonly memory = new InMemoryTupleStorage()

	scan(args?: ScanStorageArgs) {
		return Promise.resolve(
			this.memory.scan(args) as TandemClientTuple<TodoSchema>[],
		)
	}

	commit(writes: WriteOps<TandemClientTuple<TodoSchema>>) {
		this.memory.commit(writes)
		return Promise.resolve()
	}

	close() {
		return Promise.resolve()
	}

	clear() {
		this.memory.commit({ remove: this.memory.scan().map(({ key }) => key) })
		return Promise.resolve()
	}
}

const test = baseTest.extend<{
	backend: TodoBackend
	/** A connected client subscribed to every todo, recording each distinct list it shows. */
	connect: (options?: { clientStorage?: MemoryClientStorage }) => Promise<{
		client: TandemClient<TodoSchema, {}, typeof todoMutators>
		seen: Todo[][]
	}>
}>({
	backend: async ({}, use) => {
		const backend = new TodoBackend()
		await use(backend)
		await backend.tandem.close()
	},
	connect: async ({ backend }, use) => {
		await using cleanup = new errore.AsyncDisposableStack()
		await use(async ({ clientStorage } = {}) => {
			const client = new TandemClient({
				schema,
				mutators: todoMutators,
				remote: backend.remote(),
				clientStorage,
				logger: new Logger({ sinks: [] }),
				syncInterval: 0,
				clientStorageWriteInterval: 0,
			})
			const seen: Todo[][] = []
			const todos = client.subscribe({ collection: "todos" }, (result) => {
				if (JSON.stringify(result) !== JSON.stringify(seen.at(-1)))
					seen.push([...result])
			})
			cleanup.defer(async () => {
				todos.destroy()
				await client.disconnect()
			})
			await client.ready
			await client.pullFromRemote()
			return { client, seen }
		})
	},
})

test("a mutator shows its optimistic result until the server's run replaces it", async ({
	backend,
	connect,
}) => {
	const { client, seen } = await connect()

	await client.mutate.addTodo({ id: "todo-1", text: "Buy milk" })

	const todo = { id: "todo-1", text: "Buy milk", done: false }
	await vi.waitFor(() =>
		expect(client.query({ collection: "todos" })).toEqual([
			{ ...todo, author: "ada" },
		]),
	)
	expect(seen).toEqual([
		[{ ...todo, author: "you" }],
		[{ ...todo, author: "ada" }],
	])
	expect(await backend.todos()).toEqual([{ ...todo, author: "ada" }])
})

test("a mutator that throws on the client writes nothing and is never pushed", async ({
	backend,
	connect,
}) => {
	const { client } = await connect()

	await expect(client.mutate.toggleTodo({ id: "missing" })).rejects.toThrow(
		"No todo missing",
	)
	// Invalid arguments fail the same way, before the mutator runs.
	await expect(
		client.mutate.addTodo({ id: "todo-1" } as { id: string; text: string }),
	).rejects.toThrow("Expected an id and text")

	await client.mutate.addTodo({ id: "todo-2", text: "Pushed" })
	expect(backend.announced).toEqual(["todo-2"])
})

test("a refused mutation rejects its call, rolls back, and does not block later ones", async ({
	backend,
	connect,
}) => {
	const { client } = await connect()

	backend.user = undefined
	const refused = client.mutate.addTodo({ id: "todo-1", text: "Anonymous" })
	await expect(refused).rejects.toBeInstanceOf(MutationRejectedError)
	await expect(refused).rejects.toThrow("Sign in to add todos")
	await vi.waitFor(() =>
		expect(client.query({ collection: "todos" })).toEqual([]),
	)

	backend.user = "ada"
	await client.mutate.addTodo({ id: "todo-2", text: "Signed in" })
	await vi.waitFor(() =>
		expect(client.query({ collection: "todos" })).toEqual([
			{ id: "todo-2", text: "Signed in", done: false, author: "ada" },
		]),
	)
	expect(backend.announced).toEqual(["todo-2"])
})

test("an after effect runs once when the push that applied it is retried", async ({
	backend,
	connect,
}) => {
	const { client } = await connect()

	backend.loseNextResponse = true
	await expect(
		client.mutate.addTodo({ id: "todo-1", text: "First" }),
	).rejects.toThrow("Remote push failed")

	// The next push carries both mutations; the server skips the applied one.
	await client.mutate.addTodo({ id: "todo-2", text: "Second" })

	expect(backend.announced).toEqual(["todo-1", "todo-2"])
	expect((await backend.todos()).map(({ id }) => id)).toEqual([
		"todo-1",
		"todo-2",
	])
})

test("a storage failure inside a mutator leaves it pending until a later push applies it", async ({
	backend,
	connect,
}) => {
	const { client } = await connect()

	backend.storage.failNextScan(new Error("Disk unavailable"), "record")
	await expect(
		client.mutate.addTodo({ id: "todo-1", text: "Retry me" }),
	).rejects.toThrow("Remote push failed")
	expect(backend.announced).toEqual([])
	expect(client.query({ collection: "todos" })).toEqual([
		{ id: "todo-1", text: "Retry me", done: false, author: "you" },
	])

	await client.mutate.addTodo({ id: "todo-2", text: "Next" })
	expect(backend.announced).toEqual(["todo-1", "todo-2"])
})

test("a server with mutators refuses operations unless allowed, without blocking mutators", async ({
	backend,
	connect,
}) => {
	const { client } = await connect()

	const tx = client.transact()
	tx.set("todos", { id: "todo-1", text: "Forged", done: true, author: "eve" })
	await expect(client.commit(tx)).rejects.toBeInstanceOf(MutationRejectedError)
	await vi.waitFor(() =>
		expect(client.query({ collection: "todos" })).toEqual([]),
	)
	await client.mutate.addTodo({ id: "todo-2", text: "Named" })

	// A server that opts in applies them again.
	backend.allowOps = true
	const allowedTx = client.transact()
	allowedTx.set("todos", {
		id: "todo-3",
		text: "Raw",
		done: false,
		author: "ada",
	})
	await client.commit(allowedTx)
	expect((await backend.todos()).map(({ id }) => id)).toEqual([
		"todo-2",
		"todo-3",
	])
})

test("a bug in a server mutator is a refusal, not a storage failure that blocks the queue", async ({
	backend,
	connect,
}) => {
	const { client } = await connect()

	backend.queryBug = true
	await expect(
		client.mutate.addTodo({ id: "todo-1", text: "Buggy" }),
	).rejects.toBeInstanceOf(MutationRejectedError)

	backend.queryBug = false
	await client.mutate.addTodo({ id: "todo-2", text: "Fixed" })
	expect(backend.announced).toEqual(["todo-2"])
})

test("concurrent calls that read the same record each apply on the latest state", async ({
	backend,
	connect,
}) => {
	const { client } = await connect()
	await client.mutate.addTodo({ id: "todo-1", text: "Flip twice" })

	await Promise.all([
		client.mutate.toggleTodo({ id: "todo-1" }),
		client.mutate.toggleTodo({ id: "todo-1" }),
	])

	expect(await backend.todos()).toEqual([
		{ id: "todo-1", text: "Flip twice", done: false, author: "ada" },
	])
})

test("changing the argument object after a call does not change what the server runs", async ({
	backend,
	connect,
}) => {
	const { client } = await connect()

	const args = { id: "todo-1", text: "As called" }
	const calling = client.mutate.addTodo(args)
	args.text = "Changed later"
	await calling

	expect((await backend.todos()).map(({ text }) => text)).toEqual(["As called"])
})

test("a mutator the server does not have is rejected, as for a client newer than the deploy", async ({
	backend,
	connect,
}) => {
	const { client } = await connect()
	await client.mutate.addTodo({ id: "todo-1", text: "Buy milk" })

	backend.missing = ["toggleTodo"]
	await expect(client.mutate.toggleTodo({ id: "todo-1" })).rejects.toThrow(
		"Unknown mutator toggleTodo",
	)
	await vi.waitFor(() =>
		expect(client.query({ collection: "todos" })).toEqual([
			{ id: "todo-1", text: "Buy milk", done: false, author: "ada" },
		]),
	)
})

test("a named mutation made offline survives a restart and runs on the server after reconnect", async ({
	backend,
	connect,
}) => {
	const clientStorage = new MemoryClientStorage()
	const offline = new TandemClient({
		schema,
		mutators: todoMutators,
		remote: backend.remote(),
		clientStorage,
		logger: new Logger({ sinks: [] }),
		autoConnect: false,
		syncInterval: 0,
		clientStorageWriteInterval: 0,
	})
	await offline.ready
	await offline.mutate.addTodo({ id: "todo-1", text: "Written offline" })
	await offline.flushClientStorage()
	expect(backend.announced).toEqual([])

	const { client } = await connect({ clientStorage })

	await vi.waitFor(() =>
		expect(client.query({ collection: "todos" })).toEqual([
			{ id: "todo-1", text: "Written offline", done: false, author: "ada" },
		]),
	)
	expect(backend.announced).toEqual(["todo-1"])
})
