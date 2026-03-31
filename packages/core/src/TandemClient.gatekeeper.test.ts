import { Gatekeeper } from "@tandem/gatekeeper"
import type {
	ClientApi,
	ClientId,
	Cookie,
	MutationId,
	Patch,
	RemoteApi,
	RngApi,
} from "@tandem/types"
import { describe, expect, test as base, vi } from "vitest"
import { TandemClient } from "./TandemClient"
import type { LoggerApi } from "./utils/Logger"
import type { AsyncUnsubscribe } from "./utils/typeUtils"

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
const MUTATION_2 = "mutation-2" as MutationId
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

type PullResponse = Awaited<ReturnType<RemoteApi<TodosSchema>["pull"]>>

class ScriptedRemote implements RemoteApi<TodosSchema> {
	readonly pushCalls: Array<Parameters<RemoteApi<TodosSchema>["push"]>[0]> = []
	readonly pullCalls: Array<Parameters<RemoteApi<TodosSchema>["pull"]>[0]> = []
	readonly connectedClientIds: ClientId[] = []

	private readonly clients = new Map<ClientId, ClientApi>()
	private readonly pullResponses: PullResponse[] = []

	enqueuePullResponse(response: PullResponse): void {
		this.pullResponses.push(response)
	}

	pokeAll(): void {
		for (const client of this.clients.values()) {
			client.poke()
		}
	}

	async connect(api: ClientApi): Promise<AsyncUnsubscribe> {
		this.connectedClientIds.push(api.clientId)
		this.clients.set(api.clientId, api)

		return async () => {
			this.clients.delete(api.clientId)
		}
	}

	async push(
		args: Parameters<RemoteApi<TodosSchema>["push"]>[0],
	): Promise<void> {
		this.pushCalls.push(args)
	}

	async pull(
		args: Parameters<RemoteApi<TodosSchema>["pull"]>[0],
	): Promise<PullResponse> {
		this.pullCalls.push(args)

		const next = this.pullResponses.shift()
		if (!next) {
			throw new Error("No scripted pull response available")
		}

		return next
	}
}

class TandemAppService {
	private readonly client: TandemClient<TodosSchema>
	private subscription?: { destroy: () => void }

	constructor(args: {
		remote: RemoteApi<TodosSchema>
		rng: RngApi
	}) {
		this.client = new TandemClient<TodosSchema>({
			remote: args.remote,
			rng: args.rng,
			logger: new SilentLogger(),
			autoConnect: false,
			syncInterval: SYNC_INTERVAL,
		})
	}

	async connectWithTodosSubscription(): Promise<Todo[]> {
		await this.client.ready
		this.subscription = this.client.subscribe(
			"todos",
			(query) => query.select("*"),
			() => {},
		)

		await this.client.connect()
		return await this.readTodos()
	}

	async commitTodo(todo: Todo): Promise<Todo[]> {
		await this.client.ready

		const tx = this.client.transact()
		tx.set("todos", todo)

		await this.client.commit(tx)

		return await this.readTodos()
	}

	async pullAndRead(): Promise<Todo[]> {
		await this.client.ready

		await this.client.pullFromRemote()

		return await this.readTodos()
	}

	async readTodos(): Promise<Todo[]> {
		await this.client.ready
		return this.client.run("todos", (query) => query.select("*"))
	}

	cleanup(): void {
		this.subscription?.destroy()
		this.subscription = undefined
	}
}

function cookie(value: number): Cookie {
	return value as Cookie
}

function pullResponse(args: {
	cookie: number
	patch?: Patch<TodosSchema>
	lastMutationId?: MutationId
}): PullResponse {
	return {
		cookie: cookie(args.cookie),
		patch: args.patch ?? { set: [], remove: [] },
		lastMutationId: args.lastMutationId,
	}
}

function pushRequest(mutationId: MutationId, todo: Todo) {
	const args: Parameters<RemoteApi<TodosSchema>["push"]> = [
		{
			clientId: CLIENT_ID,
			mutations: [
				{
					id: mutationId,
					ops: [{ type: "set", collection: "todos", value: todo }],
				},
			],
		},
	]

	return {
		to: "remote" as const,
		method: "push" as const,
		args,
	}
}

function pullRequest(currentCookie: Cookie | undefined) {
	const args: Parameters<RemoteApi<TodosSchema>["pull"]> = [
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

function createTandemFixture() {
	const remote = new ScriptedRemote()
	const rng = new SequenceRng([
		CLIENT_ID,
		MUTATION_1,
		MUTATION_2,
		"mutation-3",
		"mutation-4",
	])

	let app!: TandemAppService

	const harness = new Gatekeeper()
		.add("remote", () => remote)
		.add("app", ({ remote }) => {
			app = new TandemAppService({ remote, rng })
			return app
		})
		.build()

	return { harness, remote, app }
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
			tandem.app.cleanup()
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

async function connectAndHydrate(
	tandem: TandemFixture,
	response: PullResponse = pullResponse({ cookie: 0 }),
) {
	tandem.remote.enqueuePullResponse(response)

	const connecting = await tandem.harness.app.connectWithTodosSubscription()
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

		const done = await connectAndHydrate(
			tandem,
			pullResponse({
				cookie: 0,
				patch: {
					set: [{ collection: "todos", value: remoteTodo }],
				},
			}),
		)

		expect(done.unwrapValue()).toEqual([remoteTodo])
		expect(await tandem.app.readTodos()).toEqual([remoteTodo])
		expect(tandem.remote.connectedClientIds).toEqual([CLIENT_ID])
	})

	test("a commit is optimistic locally and then gets pushed to the remote", async ({ tandem }) => {
		const todo: Todo = {
			id: "todo-1",
			text: "optimistic",
			complete: false,
		}

		const pushingPromise = tandem.harness.app.commitTodo(todo)
		await letInvocationSchedule()
		await tandem.advanceTime()
		const pushing = await pushingPromise
		pushing.expectRequest(pushRequest(MUTATION_1, todo))

		expect(await tandem.app.readTodos()).toEqual([todo])

		const done = await pushing.allowRequest(pushRequest(MUTATION_1, todo))

		expect(done.unwrapValue()).toEqual([todo])
		expect(tandem.remote.pushCalls).toEqual([
			{
				clientId: CLIENT_ID,
				mutations: [
					{
						id: MUTATION_1,
						ops: [{ type: "set", collection: "todos", value: todo }],
					},
				],
			},
		])
	})

	test("a failed push rolls back the optimistic local change", async ({ tandem }) => {
		const todo: Todo = {
			id: "todo-1",
			text: "rollback me",
			complete: false,
		}

		const pushingPromise = tandem.harness.app.commitTodo(todo)
		await letInvocationSchedule()
		await tandem.advanceTime()
		const pushing = await pushingPromise
		pushing.expectRequest(pushRequest(MUTATION_1, todo))

		expect(await tandem.app.readTodos()).toEqual([todo])

		const done = await pushing.fail(new Error("remote down"))

		expect(done.unwrapValue()).toEqual([])
		expect(await tandem.app.readTodos()).toEqual([])
		expect(tandem.remote.pushCalls).toEqual([])
	})

	test("a pull rebases acknowledged server state under a still-speculative local mutation", async ({ tandem }) => {
		const serverVersion: Todo = {
			id: "todo-1",
			text: "from server",
			complete: false,
		}
		const localVersion: Todo = {
			id: "todo-1",
			text: "edited locally",
			complete: true,
		}
		const extraRemoteTodo: Todo = {
			id: "todo-2",
			text: "another remote todo",
			complete: false,
		}

		const connected = await connectAndHydrate(tandem)
		expect(connected.unwrapValue()).toEqual([])

		const firstPushPromise = tandem.harness.app.commitTodo(serverVersion)
		await letInvocationSchedule()
		await tandem.advanceTime()
		const firstPush = await firstPushPromise
		const firstDone = await firstPush.allowRequest(
			pushRequest(MUTATION_1, serverVersion),
		)
		expect(firstDone.unwrapValue()).toEqual([serverVersion])

		const secondPushPromise = tandem.harness.app.commitTodo(localVersion)
		await letInvocationSchedule()
		await tandem.advanceTime()
		const secondPush = await secondPushPromise
		expect(await tandem.app.readTodos()).toEqual([localVersion])
		const secondDone = await secondPush.allowRequest(
			pushRequest(MUTATION_2, localVersion),
		)
		expect(secondDone.unwrapValue()).toEqual([localVersion])

		tandem.remote.enqueuePullResponse(
			pullResponse({
				cookie: 1,
				lastMutationId: MUTATION_1,
				patch: {
					set: [
						{ collection: "todos", value: serverVersion },
						{ collection: "todos", value: extraRemoteTodo },
					],
				},
			}),
		)

		const pullingPromise = tandem.harness.app.pullAndRead()
		await letInvocationSchedule()
		await tandem.advanceTime()
		const pulling = await pullingPromise
		pulling.expectRequest(pullRequest(cookie(0)))

		const done = await pulling.allowRequest(pullRequest(cookie(0)))

		expect(done.unwrapValue()).toEqual([localVersion, extraRemoteTodo])
		expect(await tandem.app.readTodos()).toEqual([localVersion, extraRemoteTodo])
	})
})
