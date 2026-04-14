import { Gatekeeper, GatekeeperBuilder } from "@tandem/gatekeeper"
import { TestRemote } from "@tandem/testing"
import type {
	ClientId,
	Cookie,
	Mutation,
	MutationId,
	RngApi,
} from "@tandem/types"
import { describe, expect, test as base } from "vitest"
import { TandemClient } from "./TandemClient"
import { Timer } from "./utils/Timer"
import type { LoggerApi } from "./utils/Logger"

type Todo = {
	id: string
	text: string
	complete: boolean
}

type TodosSchema = {
	todos: Todo
}

type Services = {
	remote: TestRemote<TodosSchema>
	timer: Timer
	client1: TandemClient<TodosSchema>
	client2: TandemClient<TodosSchema>
}

type TestHarness = Gatekeeper<Services>

const SYNC_INTERVAL = 1

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

const timerDelay = (ms: number) => ({
	to: "timer" as const,
	method: "delay" as const,
	args: [ms] as [number],
})

const test = base.extend<{
	harness: TestHarness
}>({
	harness: async ({}, use) => {
		const client1Rng = new SequenceRng([
			"client-1",
			"mutation-1",
			"mutation-2",
			"mutation-3",
			"mutation-4",
		])
		const client2Rng = new SequenceRng([
			"client-2",
			"client-2-mutation-1",
			"client-2-mutation-2",
			"client-2-mutation-3",
			"client-2-mutation-4",
		])

		const harness = new GatekeeperBuilder()
			.add(
				"remote",
				() => new TestRemote<TodosSchema>({ logger: new SilentLogger() }),
			)
			.add("timer", () => new Timer())
			.add("client1", ({ remote, timer }) => {
				return new TandemClient<TodosSchema>({
					remote,
					timer,
					rng: client1Rng,
					logger: new SilentLogger(),
					autoConnect: true,
					syncInterval: SYNC_INTERVAL,
				})
			})
			.add("client2", ({ remote, timer }) => {
				return new TandemClient<TodosSchema>({
					remote,
					timer,
					rng: client2Rng,
					logger: new SilentLogger(),
					autoConnect: true,
					syncInterval: SYNC_INTERVAL,
				})
			})
			.build()

		await harness.client1.ready
		await harness.client2.ready

		try {
			await use(harness)
		} finally {
			await harness.withUnlockedGates(async ({ client1, client2 }) => {
				await client1.disconnect()
				await client2.disconnect()
			})
		}
	},
})

describe("TandemClient with Gatekeeper", () => {
	test("a subscribed client connects and hydrates from remote state", async ({
		harness,
	}) => {
		const client2MutationId = "client-2-mutation-1" as MutationId
		const remoteTodo: Todo = {
			id: "todo-1",
			text: "from remote",
			complete: false,
		}
		const remoteMutation: Mutation<TodosSchema> = {
			id: client2MutationId,
			ops: [{ type: "set", collection: "todos", value: remoteTodo }],
		}

		await harness.withUnlockedGates(async ({ client2 }) => {
			const tx = client2.transact()
			tx.set("todos", remoteTodo)
			await client2.commit(tx)
		})

		// subscribe() is sync but fires a background pull — run it with
		// unlocked gates so the pull completes without gatekeeper interference.
		const subscription = await harness.withUnlockedGates(({ client1 }) =>
			client1.subscribe(
				"todos",
				(query) => query.select("*"),
				() => {},
			),
		)

		try {
			// Ensure the background pull triggered by subscribe completes.
			await harness.withUnlockedGates(({ client1 }) => client1.pullFromRemote())

			expect(
				await harness.withUnlockedGates(({ client1 }) => {
					return client1.run("todos", (query) => query.select("*"))
				}),
			).toEqual([remoteTodo])
			expect(harness.remote.getMutations()).toEqual([remoteMutation])
		} finally {
			subscription.destroy()
		}
	})

	test("a commit is optimistic locally and then gets pushed to the remote", async ({
		harness,
	}) => {
		const clientId = "client-1" as ClientId
		const mutationId = "mutation-1" as MutationId
		const todo: Todo = {
			id: "todo-1",
			text: "optimistic",
			complete: false,
		}
		const pushedMutation: Mutation<TodosSchema> = {
			id: mutationId,
			ops: [{ type: "set", collection: "todos", value: todo }],
		}

		const subscription = await harness.withUnlockedGates(({ client1 }) =>
			client1.subscribe(
				"todos",
				(query) => query.select("*"),
				() => {},
			),
		)

		try {
			expect(
				await harness.withUnlockedGates(({ client1 }) => {
					return client1.run("todos", (query) => query.select("*"))
				}),
			).toEqual([])

			const tx = harness.client1.transact()
			tx.set("todos", todo)
			const handle = await harness.client1.commit(tx)

			expect(
				await harness.withUnlockedGates(({ client1 }) => {
					return client1.run("todos", (query) => query.select("*"))
				}),
			).toEqual([todo])

			// commit() enqueues a push, which first blocks on timer.delay()
			const afterDelay = await handle.allowRequest(timerDelay(SYNC_INTERVAL))

			// After the delay, it blocks on remote.push()
			const committed = await afterDelay.allowRequest({
				to: "remote",
				method: "push",
				args: [{ clientId, mutations: [pushedMutation] }],
			})

			expect(committed.unwrapValue()).toBeUndefined()
			expect(
				await harness.withUnlockedGates(({ client1 }) => {
					return client1.run("todos", (query) => query.select("*"))
				}),
			).toEqual([todo])
			expect(harness.remote.getMutations()).toEqual([pushedMutation])
		} finally {
			subscription.destroy()
		}
	})

	test("a failed push rolls back the optimistic local change", async ({
		harness,
	}) => {
		const todo: Todo = {
			id: "todo-1",
			text: "rollback me",
			complete: false,
		}

		const subscription = await harness.withUnlockedGates(({ client1 }) =>
			client1.subscribe(
				"todos",
				(query) => query.select("*"),
				() => {},
			),
		)

		try {
			expect(
				await harness.withUnlockedGates(({ client1 }) => {
					return client1.run("todos", (query) => query.select("*"))
				}),
			).toEqual([])

			const tx = harness.client1.transact()
			tx.set("todos", todo)
			const handle = await harness.client1.commit(tx)

			expect(
				await harness.withUnlockedGates(({ client1 }) => {
					return client1.run("todos", (query) => query.select("*"))
				}),
			).toEqual([todo])

			// commit() enqueues a push, which first blocks on timer.delay()
			const afterDelay = await handle.allowRequest(timerDelay(SYNC_INTERVAL))

			// After the delay, it blocks on remote.push() — fail it
			await expect(afterDelay.fail(new Error("remote down"))).rejects.toThrow(
				"remote down",
			)

			expect(
				await harness.withUnlockedGates(({ client1 }) => {
					return client1.run("todos", (query) => query.select("*"))
				}),
			).toEqual([])
			expect(harness.remote.getMutations()).toEqual([])
		} finally {
			subscription.destroy()
		}
	})

	test("two optimistic commits can share one push and both commits resolve", async ({
		harness,
	}) => {
		const clientId = "client-1" as ClientId
		const firstMutationId = "mutation-1" as MutationId
		const secondMutationId = "mutation-2" as MutationId
		const firstTodo: Todo = {
			id: "todo-1",
			text: "first",
			complete: false,
		}
		const secondTodo: Todo = {
			id: "todo-2",
			text: "second",
			complete: true,
		}
		const firstMutation: Mutation<TodosSchema> = {
			id: firstMutationId,
			ops: [{ type: "set", collection: "todos", value: firstTodo }],
		}
		const secondMutation: Mutation<TodosSchema> = {
			id: secondMutationId,
			ops: [{ type: "set", collection: "todos", value: secondTodo }],
		}

		const subscription = await harness.withUnlockedGates(({ client1 }) =>
			client1.subscribe(
				"todos",
				(query) => query.select("*"),
				() => {},
			),
		)

		try {
			const firstTx = harness.client1.transact()
			firstTx.set("todos", firstTodo)
			const firstHandle = await harness.client1.commit(firstTx)

			const secondTx = harness.client1.transact()
			secondTx.set("todos", secondTodo)
			// Don't await — the second commit shares the first's ThrottleQueue
			// batch, so its handle won't resolve until the batch completes.
			const secondCommit = harness.client1.commit(secondTx)

			expect(
				await harness.withUnlockedGates(({ client1 }) => {
					return client1.run("todos", (query) => query.select("*"))
				}),
			).toEqual([firstTodo, secondTodo])

			// Both commits share the same ThrottleQueue batch. The first commit
			// owns the async chain (timer.delay → remote.push), so we drive it
			// through the first handle.
			const afterDelay = await firstHandle.allowRequest(
				timerDelay(SYNC_INTERVAL),
			)

			const firstCommit = await afterDelay.allowRequest({
				to: "remote",
				method: "push",
				args: [{ clientId, mutations: [firstMutation, secondMutation] }],
			})

			expect(firstCommit.unwrapValue()).toBeUndefined()
			// The second commit shares the same underlying promise and resolves
			// once the batch completes.
			expect((await secondCommit).unwrapValue()).toBeUndefined()
			expect(harness.remote.getMutations()).toEqual([
				firstMutation,
				secondMutation,
			])
		} finally {
			subscription.destroy()
		}
	})

	test("two concurrent commits from different clients can block and resolve independently", async ({
		harness,
	}) => {
		const client1Id = "client-1" as ClientId
		const client2Id = "client-2" as ClientId
		const mutation1Id = "mutation-1" as MutationId
		const client2Mutation1Id = "client-2-mutation-1" as MutationId
		const todo1: Todo = { id: "todo-1", text: "from client1", complete: false }
		const todo2: Todo = { id: "todo-2", text: "from client2", complete: true }
		const mutation1: Mutation<TodosSchema> = {
			id: mutation1Id,
			ops: [{ type: "set", collection: "todos", value: todo1 }],
		}
		const mutation2: Mutation<TodosSchema> = {
			id: client2Mutation1Id,
			ops: [{ type: "set", collection: "todos", value: todo2 }],
		}

		const [sub1, sub2] = await harness.withUnlockedGates(
			({ client1, client2 }) => [
				client1.subscribe(
					"todos",
					(query) => query.select("*"),
					() => {},
				),
				client2.subscribe(
					"todos",
					(query) => query.select("*"),
					() => {},
				),
			],
		)

		try {
			// Both clients commit concurrently
			const tx1 = harness.client1.transact()
			tx1.set("todos", todo1)
			const handle1 = await harness.client1.commit(tx1)

			const tx2 = harness.client2.transact()
			tx2.set("todos", todo2)
			const handle2 = await harness.client2.commit(tx2)

			// Each client has its own pushQueue, so each blocks on its own timer.delay()
			const [afterDelay1, afterDelay2] = await Promise.all([
				handle1.allowRequest(timerDelay(SYNC_INTERVAL)),
				handle2.allowRequest(timerDelay(SYNC_INTERVAL)),
			])

			const push1Request = {
				to: "remote" as const,
				method: "push" as const,
				args: [{ clientId: client1Id, mutations: [mutation1] }] as Parameters<
					TestRemote<TodosSchema>["push"]
				>,
			}
			const push2Request = {
				to: "remote" as const,
				method: "push" as const,
				args: [{ clientId: client2Id, mutations: [mutation2] }] as Parameters<
					TestRemote<TodosSchema>["push"]
				>,
			}

			// Resolve client2 first (out of order)
			const committed2 = await afterDelay2.allowRequest(push2Request)
			expect(committed2.unwrapValue()).toBeUndefined()

			// Then resolve client1
			const committed1 = await afterDelay1.allowRequest(push1Request)
			expect(committed1.unwrapValue()).toBeUndefined()

			// Both mutations should be on the remote
			expect(harness.remote.getMutations()).toEqual([mutation2, mutation1])
		} finally {
			sub1.destroy()
			sub2.destroy()
		}
	})

	test("a pull acknowledges local remote state and applies changes from another client", async ({
		harness,
	}) => {
		const clientId = "client-1" as ClientId
		const localMutationId = "mutation-1" as MutationId
		const client2MutationId = "client-2-mutation-1" as MutationId
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
		const localMutation: Mutation<TodosSchema> = {
			id: localMutationId,
			ops: [{ type: "set", collection: "todos", value: localTodo }],
		}
		const extraRemoteMutation: Mutation<TodosSchema> = {
			id: client2MutationId,
			ops: [{ type: "set", collection: "todos", value: extraRemoteTodo }],
		}

		const subscription = await harness.withUnlockedGates(({ client1 }) =>
			client1.subscribe(
				"todos",
				(query) => query.select("*"),
				() => {},
			),
		)

		try {
			expect(
				await harness.withUnlockedGates(({ client1 }) => {
					return client1.run("todos", (query) => query.select("*"))
				}),
			).toEqual([])

			const tx = harness.client1.transact()
			tx.set("todos", localTodo)
			const handle = await harness.client1.commit(tx)

			expect(
				await harness.withUnlockedGates(({ client1 }) => {
					return client1.run("todos", (query) => query.select("*"))
				}),
			).toEqual([localTodo])

			// Allow timer delay, then push
			const afterDelay = await handle.allowRequest(timerDelay(SYNC_INTERVAL))
			await afterDelay.allowRequest({
				to: "remote",
				method: "push",
				args: [{ clientId, mutations: [localMutation] }],
			})

			// Client2 commits via unlocked gates. The push triggers a poke to
			// client1, which fires a background pull through the (real-timer)
			// pull queue.
			await harness.withUnlockedGates(async ({ client2 }) => {
				const tx = client2.transact()
				tx.set("todos", extraRemoteTodo)
				await client2.commit(tx)
			})

			// Drain any poke-triggered background pulls so client1 is fully
			// synced before we assert.
			await harness.withUnlockedGates(({ client1 }) => client1.pullFromRemote())

			expect(
				await harness.withUnlockedGates(({ client1 }) => {
					return client1.run("todos", (query) => query.select("*"))
				}),
			).toEqual([localTodo, extraRemoteTodo])
			expect(harness.remote.getMutations()).toEqual([
				localMutation,
				extraRemoteMutation,
			])
		} finally {
			subscription.destroy()
		}
	})
})
