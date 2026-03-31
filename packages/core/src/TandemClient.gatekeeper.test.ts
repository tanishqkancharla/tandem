import { Gatekeeper } from "@tandem/gatekeeper"
import { TestRemote } from "@tandem/testing"
import type { ClientId, Cookie, Mutation, MutationId, RngApi } from "@tandem/types"
import { describe, expect, test as base, vi } from "vitest"
import { TandemClient } from "./TandemClient"
import type { LoggerApi } from "./utils/Logger"

type Todo = {
	id: string
	text: string
	complete: boolean
}

type TodosSchema = {
	todos: Todo
}

const CLIENT_ID = "client-1" as ClientId
const MUTATION_1 = "mutation-1" as MutationId
const SERVER_CLIENT_1 = "server-client-1" as ClientId
const SERVER_CLIENT_2 = "server-client-2" as ClientId
const SERVER_MUTATION_1 = "server-mutation-1" as MutationId
const SERVER_MUTATION_2 = "server-mutation-2" as MutationId
const SYNC_INTERVAL = 5
const TODOS_QUERY = { collection: "todos", select: "*" } as const

class SilentLogger implements LoggerApi {
	log(_message: string, ..._args: any[]): void {}

	error(_message: string, ..._args: any[]): void {}

	warn(_message: string, ..._args: any[]): void {}

	info(_message: string, ..._args: any[]): void {}

	scope(_name: string): LoggerApi {
		return this
	}
}

class SequenceRng implements RngApi {
	private readonly values: string[]

	constructor(values: string[]) {
		this.values = [...values]
	}

	randomId(): string {
		const next = this.values.shift()
		if (!next) {
			throw new Error("Test RNG ran out of ids")
		}

		return next
	}
}

async function readTodos(client: TandemClient<TodosSchema>): Promise<Todo[]> {
	await client.ready
	return client.run("todos", (query) => query.select("*"))
}

function cookie(value: number): Cookie {
	return value as Cookie
}

function todoMutation(mutationId: MutationId, todo: Todo): Mutation<TodosSchema> {
	return {
		id: mutationId,
		ops: [{ type: "set", collection: "todos", value: todo }],
	}
}

function pushRequest(mutationId: MutationId, todo: Todo) {
	const args: Parameters<TestRemote<TodosSchema>["push"]> = [
		{
			clientId: CLIENT_ID,
			mutations: [todoMutation(mutationId, todo)],
		},
	]

	return {
		to: "remote" as const,
		method: "push" as const,
		args,
	}
}

function pullRequest(currentCookie: Cookie | undefined) {
	const args: Parameters<TestRemote<TodosSchema>["pull"]> = [
		{
			clientId: CLIENT_ID,
			cookie: currentCookie,
			scanWindow: [TODOS_QUERY],
		},
	]

	return {
		to: "remote" as const,
		method: "pull" as const,
		args,
	}
}

async function seedRemoteMutations(
	remote: TestRemote<TodosSchema>,
	clientId: ClientId,
	mutations: Mutation<TodosSchema>[]
) {
	const disconnect = await remote.connect({ clientId, poke: () => {} })

	try {
		await remote.push({ clientId, mutations })
	} finally {
		await disconnect()
	}
}

function createTandemFixture() {
	const remote = new TestRemote<TodosSchema>({ logger: new SilentLogger() })
	const rng = new SequenceRng([CLIENT_ID, MUTATION_1, "mutation-2", "mutation-3"])

	let client!: TandemClient<TodosSchema>
	let destroySubscription: (() => void) | undefined

	const harness = new Gatekeeper()
		.add("remote", () => remote)
		.add("flows", ({ remote }) => {
			client = new TandemClient<TodosSchema>({
				remote,
				rng,
				logger: new SilentLogger(),
				autoConnect: false,
				syncInterval: SYNC_INTERVAL,
			})

			return {
				async connectWithTodosSubscription(): Promise<Todo[]> {
					await client.ready

					const subscription = client.subscribe(
						"todos",
						(query) => query.select("*"),
						() => {},
					)
					destroySubscription = subscription.destroy

					await client.connect()
					return await readTodos(client)
				},

				async commitTodo(todo: Todo): Promise<Todo[]> {
					await client.ready

					const tx = client.transact()
					tx.set("todos", todo)

					await client.commit(tx)
					return await readTodos(client)
				},

				async pullAndRead(): Promise<Todo[]> {
					await client.ready
					await client.pullFromRemote()
					return await readTodos(client)
				},
			}
		})
		.build()

	return {
		harness,
		remote,
		readTodos: () => readTodos(client),
		cleanup() {
			destroySubscription?.()
			destroySubscription = undefined
		},
	}
}

type TandemFixture = ReturnType<typeof createTandemFixture> & {
	advanceTime: (ms?: number) => Promise<void>
}

const test = base.extend<{ tandem: TandemFixture }>({
	tandem: async ({}, use) => {
		vi.useFakeTimers()

		const advanceTime = async (ms = SYNC_INTERVAL + 1): Promise<void> => {
			vi.advanceTimersByTime(ms)
			await Promise.resolve()
			await Promise.resolve()
			await Promise.resolve()
		}

		const tandem = {
			...createTandemFixture(),
			advanceTime,
		}

		try {
			await use(tandem)
		} finally {
			tandem.cleanup()
			vi.clearAllTimers()
			vi.useRealTimers()
		}
	},
})

async function letInvocationSchedule() {
	await Promise.resolve()
	await Promise.resolve()
	await Promise.resolve()
}

async function connectAndHydrate(tandem: TandemFixture) {
	const connecting = await tandem.harness.flows.connectWithTodosSubscription()
	connecting.expectRequest({ to: "remote", method: "connect", args: "*" })

	const pullingPromise = connecting.allowRequest({
		to: "remote",
		method: "connect",
		args: "*",
	})
	await letInvocationSchedule()
	await tandem.advanceTime()
	const pulling = await pullingPromise
	pulling.expectRequest(pullRequest(undefined))

	return await pulling.allowRequest(pullRequest(undefined))
}

describe("TandemClient with Gatekeeper", () => {
	test("a subscribed client connects and hydrates from remote state", async ({ tandem }) => {
		const remoteTodo: Todo = {
			id: "todo-1",
			text: "from remote",
			complete: false,
		}

		await seedRemoteMutations(tandem.remote, SERVER_CLIENT_1, [
			todoMutation(SERVER_MUTATION_1, remoteTodo),
		])

		const done = await connectAndHydrate(tandem)

		expect(done.unwrapValue()).toEqual([remoteTodo])
		expect(await tandem.readTodos()).toEqual([remoteTodo])
		expect(tandem.remote.getMutations()).toEqual([
			todoMutation(SERVER_MUTATION_1, remoteTodo),
		])
	})

	test("a commit is optimistic locally and then gets pushed to the remote", async ({ tandem }) => {
		const todo: Todo = {
			id: "todo-1",
			text: "optimistic",
			complete: false,
		}

		const connected = await connectAndHydrate(tandem)
		expect(connected.unwrapValue()).toEqual([])

		const pushingPromise = tandem.harness.flows.commitTodo(todo)
		await letInvocationSchedule()
		await tandem.advanceTime()
		const pushing = await pushingPromise
		pushing.expectRequest(pushRequest(MUTATION_1, todo))

		expect(await tandem.readTodos()).toEqual([todo])

		const done = await pushing.allowRequest(pushRequest(MUTATION_1, todo))

		expect(done.unwrapValue()).toEqual([todo])
		expect(tandem.remote.getMutations()).toEqual([todoMutation(MUTATION_1, todo)])
	})

	test("a failed push rolls back the optimistic local change", async ({ tandem }) => {
		const todo: Todo = {
			id: "todo-1",
			text: "rollback me",
			complete: false,
		}

		const connected = await connectAndHydrate(tandem)
		expect(connected.unwrapValue()).toEqual([])

		const pushingPromise = tandem.harness.flows.commitTodo(todo)
		await letInvocationSchedule()
		await tandem.advanceTime()
		const pushing = await pushingPromise
		pushing.expectRequest(pushRequest(MUTATION_1, todo))

		expect(await tandem.readTodos()).toEqual([todo])

		const done = await pushing.fail(new Error("remote down"))

		expect(done.unwrapValue()).toEqual([])
		expect(await tandem.readTodos()).toEqual([])
		expect(tandem.remote.getMutations()).toEqual([])
	})

	test("a pull acknowledges local remote state and applies changes from another client", async ({ tandem }) => {
		const localTodo: Todo = {
			id: "todo-1",
			text: "local edit",
			complete: true,
		}
		const extraRemoteTodo: Todo = {
			id: "todo-2",
			text: "another remote todo",
			complete: false,
		}

		const connected = await connectAndHydrate(tandem)
		expect(connected.unwrapValue()).toEqual([])

		const pushingPromise = tandem.harness.flows.commitTodo(localTodo)
		await letInvocationSchedule()
		await tandem.advanceTime()
		const pushing = await pushingPromise
		const pushed = await pushing.allowRequest(pushRequest(MUTATION_1, localTodo))
		expect(pushed.unwrapValue()).toEqual([localTodo])

		await seedRemoteMutations(tandem.remote, SERVER_CLIENT_2, [
			todoMutation(SERVER_MUTATION_2, extraRemoteTodo),
		])

		const pullingPromise = tandem.harness.flows.pullAndRead()
		await letInvocationSchedule()
		await tandem.advanceTime()
		const pulling = await pullingPromise
		pulling.expectRequest(pullRequest(cookie(0)))

		const done = await pulling.allowRequest(pullRequest(cookie(0)))

		expect(done.unwrapValue()).toEqual([localTodo, extraRemoteTodo])
		expect(await tandem.readTodos()).toEqual([localTodo, extraRemoteTodo])
		expect(tandem.remote.getMutations()).toEqual([
			todoMutation(MUTATION_1, localTodo),
			todoMutation(SERVER_MUTATION_2, extraRemoteTodo),
		])
	})
})
