import { Gatekeeper, GatekeeperBuilder } from "@tandem/gatekeeper"
import { TestRemote } from "@tandem/testing"
import type {
	ClientId,
	Cookie,
	Mutation,
	MutationId,
	RngApi,
} from "@tandem/types"
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

type Services = {
	remote: TestRemote<TodosSchema>
	client1: TandemClient<TodosSchema>
	client2: TandemClient<TodosSchema>
}

type TestHarness = Gatekeeper<Services>

const SYNC_INTERVAL = 1
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

const test = base.extend<{
	advanceTime: (ms?: number) => Promise<void>
	harness: TestHarness
}>({
	advanceTime: async ({}, use) => {
		vi.useFakeTimers()

		const advanceTime = async (ms = SYNC_INTERVAL + 1): Promise<void> => {
			vi.advanceTimersByTime(ms)
			await Promise.resolve()
			await Promise.resolve()
			await Promise.resolve()
		}

		try {
			await use(advanceTime)
		} finally {
			vi.clearAllTimers()
			vi.useRealTimers()
		}
	},
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
			.add("client1", ({ remote }) => {
				return new TandemClient<TodosSchema>({
					remote,
					rng: client1Rng,
					logger: new SilentLogger(),
					autoConnect: true,
					syncInterval: SYNC_INTERVAL,
				})
			})
			.add("client2", ({ remote }) => {
				return new TandemClient<TodosSchema>({
					remote,
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

async function flushInvocationMicrotasks() {
	await Promise.resolve()
	await Promise.resolve()
	await Promise.resolve()
}

describe("TandemClient with Gatekeeper", () => {
	test("a subscribed client connects and hydrates from remote state", async ({
		harness,
		advanceTime,
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

		const client2CommitPromise = harness.withUnlockedGates(({ client2 }) => {
			const tx = client2.transact()
			tx.set("todos", remoteTodo)
			return client2.commit(tx)
		})
		await flushInvocationMicrotasks()
		await advanceTime()
		await client2CommitPromise

		const subscription = harness.client1.subscribe(
			"todos",
			(query) => query.select("*"),
			() => {},
		)

		try {
			await flushInvocationMicrotasks()
			await advanceTime()

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
		advanceTime,
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

		const subscription = harness.client1.subscribe(
			"todos",
			(query) => query.select("*"),
			() => {},
		)

		try {
			await flushInvocationMicrotasks()
			await advanceTime()

			expect(
				await harness.withUnlockedGates(({ client1 }) => {
					return client1.run("todos", (query) => query.select("*"))
				}),
			).toEqual([])

			const tx = harness.client1.transact()
			tx.set("todos", todo)
			const commitPromise = harness.client1.commit(tx)

			expect(
				await harness.withUnlockedGates(({ client1 }) => {
					return client1.run("todos", (query) => query.select("*"))
				}),
			).toEqual([todo])

			await flushInvocationMicrotasks()
			await advanceTime()
			const pushing = await commitPromise

			const pushArgs: Parameters<TestRemote<TodosSchema>["push"]> = [
				{ clientId, mutations: [pushedMutation] },
			]

			const pushRequest = {
				to: "remote" as const,
				method: "push" as const,
				args: pushArgs,
			}

			pushing.expectRequest(pushRequest)
			const committed = await pushing.allowRequest(pushRequest)

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
		advanceTime,
	}) => {
		const clientId = "client-1" as ClientId
		const mutationId = "mutation-1" as MutationId
		const todo: Todo = {
			id: "todo-1",
			text: "rollback me",
			complete: false,
		}
		const pushedMutation: Mutation<TodosSchema> = {
			id: mutationId,
			ops: [{ type: "set", collection: "todos", value: todo }],
		}

		const subscription = harness.client1.subscribe(
			"todos",
			(query) => query.select("*"),
			() => {},
		)

		try {
			await flushInvocationMicrotasks()
			await advanceTime()

			expect(
				await harness.withUnlockedGates(({ client1 }) => {
					return client1.run("todos", (query) => query.select("*"))
				}),
			).toEqual([])

			const tx = harness.client1.transact()
			tx.set("todos", todo)
			const commitPromise = harness.client1.commit(tx)

			expect(
				await harness.withUnlockedGates(({ client1 }) => {
					return client1.run("todos", (query) => query.select("*"))
				}),
			).toEqual([todo])

			await flushInvocationMicrotasks()
			await advanceTime()
			const pushing = await commitPromise

			const pushArgs: Parameters<TestRemote<TodosSchema>["push"]> = [
				{ clientId, mutations: [pushedMutation] },
			]

			const pushRequest = {
				to: "remote" as const,
				method: "push" as const,
				args: pushArgs,
			}

			pushing.expectRequest(pushRequest)

			await expect(pushing.fail(new Error("remote down"))).rejects.toThrow(
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
		advanceTime,
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

		const subscription = harness.client1.subscribe(
			"todos",
			(query) => query.select("*"),
			() => {},
		)

		try {
			await flushInvocationMicrotasks()
			await advanceTime()

			const firstTx = harness.client1.transact()
			firstTx.set("todos", firstTodo)
			const firstCommitPromise = harness.client1.commit(firstTx)

			const secondTx = harness.client1.transact()
			secondTx.set("todos", secondTodo)
			const secondCommitPromise = harness.client1.commit(secondTx)

			expect(
				await harness.withUnlockedGates(({ client1 }) => {
					return client1.run("todos", (query) => query.select("*"))
				}),
			).toEqual([firstTodo, secondTodo])

			await flushInvocationMicrotasks()
			await advanceTime()
			const pushing = await secondCommitPromise

			const pushArgs: Parameters<TestRemote<TodosSchema>["push"]> = [
				{ clientId, mutations: [firstMutation, secondMutation] },
			]

			const pushRequest = {
				to: "remote" as const,
				method: "push" as const,
				args: pushArgs,
			}

			pushing.expectRequest(pushRequest)
			const secondCommit = await pushing.allowRequest(pushRequest)

			expect(secondCommit.unwrapValue()).toBeUndefined()
			expect((await firstCommitPromise).unwrapValue()).toBeUndefined()
			expect(harness.remote.getMutations()).toEqual([
				firstMutation,
				secondMutation,
			])
		} finally {
			subscription.destroy()
		}
	})

	test("a pull acknowledges local remote state and applies changes from another client", async ({
		harness,
		advanceTime,
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

		const subscription = harness.client1.subscribe(
			"todos",
			(query) => query.select("*"),
			() => {},
		)

		try {
			await flushInvocationMicrotasks()
			await advanceTime()

			expect(
				await harness.withUnlockedGates(({ client1 }) => {
					return client1.run("todos", (query) => query.select("*"))
				}),
			).toEqual([])

			const tx = harness.client1.transact()
			tx.set("todos", localTodo)
			const commitPromise = harness.client1.commit(tx)

			expect(
				await harness.withUnlockedGates(({ client1 }) => {
					return client1.run("todos", (query) => query.select("*"))
				}),
			).toEqual([localTodo])

			await flushInvocationMicrotasks()
			await advanceTime()
			const pushing = await commitPromise

			const pushArgs: Parameters<TestRemote<TodosSchema>["push"]> = [
				{ clientId, mutations: [localMutation] },
			]

			const pushRequest = {
				to: "remote" as const,
				method: "push" as const,
				args: pushArgs,
			}

			await pushing.allowRequest(pushRequest)

			const client2CommitPromise = harness.withUnlockedGates(({ client2 }) => {
				const tx = client2.transact()
				tx.set("todos", extraRemoteTodo)
				return client2.commit(tx)
			})
			await flushInvocationMicrotasks()
			await advanceTime()
			await client2CommitPromise

			const pullingPromise = harness.client1.pullFromRemote()
			await flushInvocationMicrotasks()
			await advanceTime()
			const pulling = await pullingPromise

			const pullArgs: Parameters<TestRemote<TodosSchema>["pull"]> = [
				{
					clientId,
					cookie: 2 as Cookie,
					scanWindow: [TODOS_QUERY],
				},
			]

			const pullRequest = {
				to: "remote" as const,
				method: "pull" as const,
				args: pullArgs,
			}

			pulling.expectRequest(pullRequest)
			await pulling.allowRequest(pullRequest)

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
