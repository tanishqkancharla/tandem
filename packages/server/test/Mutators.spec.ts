import {
	collection,
	defineMutators,
	defineSchema,
	Logger,
	MutationRejectedError,
	tag,
	type ClientId,
	type MutationId,
	type RemoteApi,
	TandemClient,
	type TandemClientStorageApi,
	type TandemClientTuple,
} from "@tanishqkancharla/tandem-core"
import * as errore from "errore"
import { InMemoryTupleStorage } from "tuple-database"
import { InMemoryTabs } from "@tanishqkancharla/tandem-core/internal"
import type { ScanStorageArgs, WriteOps } from "tuple-database"
import { expect, test as baseTest, vi } from "vitest"
import { TandemServer, type TandemServerPushOptions } from "../src/index.js"
import { TestTandemServerStorage } from "./TandemServerStorage.fixture.js"

type Todo = {
	id: string
	text: string
	done: boolean
	author: string
	note?: string
}
type TodoSchema = { todos: Todo }

const schema = defineSchema({
	todos: collection<Todo>({ fields: ["id", "text", "done", "author", "note"] }),
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
	appendNote: {
		args: (input: unknown) => input as { id: string; text: string },
		run: async (tx, { id, text }) => {
			if (typeof text !== "string")
				throw new Error("Appended text must be a string")
			const todo = await tx.get("todos", id)
			if (todo && text)
				tx.set("todos", { ...todo, note: (todo.note ?? "") + text })
		},
	},
})

class TodoBackend {
	readonly storage = new TestTandemServerStorage<TodoSchema>()
	readonly tandem: TandemServer<TodoSchema, {}, typeof todoMutators, string>
	constructor() {
		this.tandem = new TandemServer({
			schema,
			relations: {},
			storage: this.storage,
			mutators: todoMutators,
			hooks: (user: string | undefined) => ({
				addTodo: {
					authorize: async (tx, { id }, ctx) => {
						if (ctx.source !== "client" || !user)
							throw new Error("Sign in to add todos")
						if (this.queryBug)
							await tx.query({
								collection: "todos",
								where: { done: { $bogus: true } } as never,
							})
						if (await tx.get("todos", id)) throw new Error(`Todo ${id} exists`)
					},
					afterCommit: ({ id }) => {
						this.announced.push(id)
					},
				},
			}),
		})
	}
	/** The signed-in user each push runs as. */
	user: string | undefined = "ada"
	/** Ids of todos whose `after` effect ran, in order. */
	readonly announced: string[] = []
	/** Unset, a push with mutators refuses generic operations. */
	allowOps: boolean | undefined = undefined
	/** The addTodo override runs a malformed query, as a bug in it would. */
	queryBug = false
	/** The next push response is lost after the server applies it. */
	loseNextResponse = false
	/** Holds a push so tests can inspect the local optimistic value. */
	pushGate?: Promise<void>

	private pushOptions(): TandemServerPushOptions<string> {
		return { context: this.user, allowOps: this.allowOps }
	}

	remote(): RemoteApi<TodoSchema> {
		return {
			connect: (client) => this.tandem.connect(client),
			push: async (args) => {
				if (this.pushGate) await this.pushGate
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

test("a shared mutator runs optimistically and on the server", async ({
	backend,
	connect,
}) => {
	const { client, seen } = await connect()

	await client.mutate.addTodo({ id: "todo-1", text: "Buy milk" })

	const todo = { id: "todo-1", text: "Buy milk", done: false }
	await vi.waitFor(() =>
		expect(client.query({ collection: "todos" })).toEqual([
			{ ...todo, author: "you" },
		]),
	)
	expect(seen).toEqual([[{ ...todo, author: "you" }]])
	expect(await backend.todos()).toEqual([{ ...todo, author: "you" }])
})

test("a named append fills an absent optional string locally and on the server", async ({
	backend,
	connect,
}) => {
	const { client } = await connect()
	await client.mutate.addTodo({ id: "todo-1", text: "Draft" })
	const before = { id: "todo-1", text: "Draft", done: false, author: "you" }
	await client.mutate.appendNote({ id: "todo-1", text: "" })
	expect(client.query({ collection: "todos" })).toEqual([before])
	expect(await backend.todos()).toEqual([before])

	const pushGate = Promise.withResolvers<void>()
	backend.pushGate = pushGate.promise
	const appending = client.mutate.appendNote({ id: "todo-1", text: "!" })
	await vi.waitFor(() =>
		expect(client.query({ collection: "todos" })).toEqual([
			{ ...before, note: "!" },
		]),
	)
	expect(await backend.todos()).toEqual([before])
	pushGate.resolve()
	await appending
	expect(await backend.todos()).toEqual([{ ...before, note: "!" }])

	await expect(
		client.mutate.appendNote({
			id: "todo-1",
			text: 42 as unknown as string,
		}),
	).rejects.toThrow("Appended text must be a string")
	expect(client.query({ collection: "todos" })).toEqual([
		{ ...before, note: "!" },
	])
	expect(await backend.todos()).toEqual([{ ...before, note: "!" }])
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
			{ id: "todo-2", text: "Signed in", done: false, author: "you" },
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
		author: "you",
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
		{ id: "todo-1", text: "Flip twice", done: false, author: "you" },
	])
})

test("concurrent request hooks retain their own session after commit", async () => {
	const gate = Promise.withResolvers<void>()
	const observed: string[] = []
	const server = new TandemServer({
		schema,
		relations: {},
		storage: new TestTandemServerStorage<TodoSchema>(),
		mutators: todoMutators,
		hooks: (session: { user: string } | undefined) => ({
			addTodo: {
				afterCommit: async ({ id }) => {
					await gate.promise
					observed.push(`${id}:${session?.user}`)
				},
			},
		}),
	})
	const push = (user: string) =>
		server.push(
			{
				clientId: tag<ClientId>(user),
				mutations: [
					{
						id: tag<MutationId>(1),
						ops: [],
						mutator: { name: "addTodo", args: { id: user, text: user } },
					},
				],
			},
			{ context: { user } },
		)
	await Promise.all([push("ada"), push("lin")])
	gate.resolve()
	await vi.waitFor(() =>
		expect(observed.sort()).toEqual(["ada:ada", "lin:lin"]),
	)
	await server.close()
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

test("a newer client receives a refusal from an older server registry", async () => {
	const oldServer = new TandemServer({
		schema,
		relations: {},
		storage: new TestTandemServerStorage<TodoSchema>(),
		mutators: { addTodo: todoMutators.addTodo },
	})
	const client = new TandemClient({
		schema,
		mutators: todoMutators,
		remote: oldServer,
		logger: new Logger({ sinks: [] }),
		syncInterval: 0,
	})
	await client.ready
	client.subscribe({ collection: "todos" })
	await client.mutate.addTodo({ id: "todo-1", text: "Buy milk" })
	await expect(client.mutate.toggleTodo({ id: "todo-1" })).rejects.toThrow(
		"Unknown mutator toggleTodo",
	)
	await vi.waitFor(() =>
		expect(client.query({ collection: "todos" })[0]?.done).toBe(false),
	)
	expect((await oldServer.query({ collection: "todos" }))[0]?.done).toBe(false)
	await client.disconnect()
	await oldServer.close()
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
			{ id: "todo-1", text: "Written offline", done: false, author: "you" },
		]),
	)
	await vi.waitFor(() => expect(backend.announced).toEqual(["todo-1"]))
})

test("coordinated tabs forward named calls, refusals, and retried pushes", async ({
	backend,
}) => {
	const browser = new InMemoryTabs()
	const storage = new MemoryClientStorage()
	const opened = [] as {
		client: TandemClient<TodoSchema, {}, typeof todoMutators>
		tab: ReturnType<typeof browser.openTab>
	}[]
	for (let index = 0; index < 2; index++) {
		const tab = browser.openTab()
		const client = new TandemClient({
			schema,
			mutators: todoMutators,
			remote: backend.remote(),
			clientStorage: storage,
			clientStorageWriteInterval: 0,
			syncInterval: 0,
			logger: new Logger({ sinks: [] }),
			tabs: {
				name: "named-todos",
				environment: {
					locks: tab.locks,
					openChannel: (name) => tab.openChannel(name),
				},
			},
		})
		opened.push({ client, tab })
		await client.ready
	}
	const follower = opened[1]!.client
	backend.user = undefined
	await expect(
		follower.mutate.addTodo({ id: "refused", text: "No" }),
	).rejects.toBeInstanceOf(MutationRejectedError)
	backend.user = "ada"
	backend.loseNextResponse = true
	await expect(
		follower.mutate.addTodo({ id: "first", text: "First" }),
	).rejects.toThrow()
	await follower.mutate.addTodo({ id: "second", text: "Second" })
	await vi.waitFor(() => expect(backend.announced).toEqual(["first", "second"]))
	backend.loseNextResponse = true
	await expect(
		follower.mutate.addTodo({ id: "third", text: "Third" }),
	).rejects.toThrow()
	opened[0]!.tab.close()
	await follower.mutate.addTodo({ id: "fourth", text: "Fourth" })
	await vi.waitFor(() =>
		expect(backend.announced).toEqual(["first", "second", "third", "fourth"]),
	)
	expect((await backend.todos()).map(({ id }) => id).sort()).toEqual([
		"first",
		"fourth",
		"second",
		"third",
	])
	await follower.disconnect()
	opened[1]!.tab.close()
})
