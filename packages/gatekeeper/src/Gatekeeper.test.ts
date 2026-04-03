import { describe, expect, test as base } from "vitest"
import { GatekeeperBuilder } from "./Gatekeeper.js"
import type { Gatekeeper, Handle, RequestMatcher } from "./Gatekeeper.js"

function compileTimeTypeAssertions(): void {
	type Services = {
		server: {
			callCount: number
			ready: Promise<void>
			nested: {
				label: string
				format(value: number): number
				increment(value: number): Promise<number>
			}
			addOne(value: number): Promise<number>
		}
		client: {
			sync: {
				label: string
				format(value: number): number
				advanceCursor(value: number): Promise<number>
			}
			addOneThroughServer(value: number): Promise<number>
		}
	}

	const harness = null as unknown as Gatekeeper<Services>
	const _ready: Promise<void> = harness.server.ready
	const _callCount: number = harness.server.callCount
	const _formatted: number = harness.server.nested.format(1)
	const _nestedLabel: string = harness.client.sync.label
	const _topLevelHandle: Promise<Handle<number, Services>> =
		harness.server.addOne(1)
	const _nestedHandle: Promise<Handle<number, Services>> =
		harness.client.sync.advanceCursor(1)
	const _unlockedValue: Promise<number> = harness.withUnlockedGates(
		async (services) => {
			const _rawNestedPromise: Promise<number> =
				services.client.sync.advanceCursor(1)
			const _rawFormatted: number = services.client.sync.format(1)

			void _rawNestedPromise
			void _rawFormatted

			return await services.server.addOne(1)
		},
	)

	const _serviceMatcher: RequestMatcher<Services> = {
		to: "server",
		method: "addOne",
		args: [1],
	}

	const _nestedServiceMatcher: RequestMatcher<Services> = {
		to: "server",
		method: "nested.increment",
		args: [1],
	}

	const _serviceWildcardMatcher: RequestMatcher<Services> = {
		to: "server",
		method: "*",
		args: [1],
	}

	const _globalWildcardMatcher: RequestMatcher<Services> = {
		to: "*",
		method: "addOne",
		args: [1],
	}

	const handle = null as unknown as Handle<number, Services>
	handle.expectRequest({ to: "server", method: "addOne", args: [1] })
	handle.expectRequest({ to: "server", method: "nested.increment", args: [1] })

	const _badServiceMatcher: RequestMatcher<Services> = {
		// @ts-expect-error invalid service name
		to: "missing",
		method: "addOne",
		args: [1],
	}

	const _badMethodMatcher: RequestMatcher<Services> = {
		to: "server",
		// @ts-expect-error invalid method for the selected service
		method: "subtractOne",
		args: [1],
	}

	const _badNestedMethodMatcher: RequestMatcher<Services> = {
		to: "server",
		// @ts-expect-error invalid nested method for the selected service
		method: "nested.decrement",
		args: [1],
	}

	// @ts-expect-error invalid argument tuple for the selected method
	handle.expectRequest({ to: "server", method: "addOne", args: ["1"] })
	// @ts-expect-error invalid argument tuple for the selected nested method
	handle.expectRequest({
		to: "server",
		method: "nested.increment",
		args: ["1"],
	})

	void harness
	void _ready
	void _callCount
	void _formatted
	void _nestedLabel
	void _topLevelHandle
	void _nestedHandle
	void _unlockedValue
	void _serviceMatcher
	void _nestedServiceMatcher
	void _serviceWildcardMatcher
	void _globalWildcardMatcher
	void _badServiceMatcher
	void _badMethodMatcher
	void _badNestedMethodMatcher
}

void compileTimeTypeAssertions

describe("Gatekeeper", () => {
	describe("when a service call finishes without touching another service", () => {
		class Counter {
			increment(value: number): Promise<number> {
				return Promise.resolve(value + 1)
			}
		}

		base("returns a resolved handle with the final value", async () => {
			const harness = new GatekeeperBuilder()
				.add("counter", () => new Counter())
				.build()

			const handle = await harness.counter.increment(5)
			expect(handle.resolved).toBe(true)
			expect(handle.unwrapValue()).toBe(6)
		})
	})

	describe("when a client call blocks on one downstream request", () => {
		class Server {
			callCount = 0

			addOne(value: number): Promise<number> {
				this.callCount += 1
				return Promise.resolve(value + 1)
			}
		}

		class Client {
			constructor(private readonly server: Server) {}

			async addOneThroughServer(value: number): Promise<number> {
				return await this.server.addOne(value)
			}
		}

		const blockingTest = base.extend<{
			harness: ReturnType<
				GatekeeperBuilder<{ server: Server; client: Client }>["build"]
			>
		}>({
			harness: async ({}, use) => {
				await use(
					new GatekeeperBuilder()
						.add("server", () => new Server())
						.add("client", ({ server }) => new Client(server))
						.build(),
				)
			},
		})

		blockingTest(
			"lets the test inspect the request before allowing it through",
			async ({ harness }) => {
				const handle = await harness.client.addOneThroughServer(1)

				expect(handle.resolved).toBe(false)
				expect(() => handle.unwrapValue()).toThrow()
				expect(() =>
					handle.expectRequest({ to: "server", method: "addOne", args: [1] }),
				).not.toThrow()
				expect(harness.server.callCount).toBe(0)

				const result = await handle.allowRequest({
					to: "server",
					method: "addOne",
					args: [1],
				})

				expect(harness.server.callCount).toBe(1)
				expect(result.resolved).toBe(true)
				expect(result.unwrapValue()).toBe(2)
			},
		)

		base(
			"intercepts async methods defined as instance properties",
			async () => {
				class FieldServer {
					callCount = 0

					addOne = async (value: number): Promise<number> => {
						this.callCount += 1
						return value + 1
					}
				}

				class FieldClient {
					constructor(private readonly server: FieldServer) {}

					addOneThroughServer = async (value: number): Promise<number> => {
						return await this.server.addOne(value)
					}
				}

				const harness = new GatekeeperBuilder()
					.add("server", () => new FieldServer())
					.add("client", ({ server }) => new FieldClient(server))
					.build()

				const handle = await harness.client.addOneThroughServer(1)

				expect(handle.resolved).toBe(false)
				handle.expectRequest({ to: "server", method: "addOne", args: [1] })
				expect(harness.server.callCount).toBe(0)

				const result = await handle.allowRequest({
					to: "server",
					method: "addOne",
					args: [1],
				})

				expect(harness.server.callCount).toBe(1)
				expect(result.unwrapValue()).toBe(2)
			},
		)

		blockingTest(
			"keeps the request blocked after a mismatched allowRequest() so the test can recover",
			async ({ harness }) => {
				const handle = await harness.client.addOneThroughServer(1)

				await expect(
					handle.allowRequest({
						to: "server",
						method: "subtractOne",
						args: [1],
					} as any),
				).rejects.toThrow("did not match")
				expect(harness.server.callCount).toBe(0)

				const result = await handle.allowRequest({
					to: "server",
					method: "addOne",
					args: [1],
				})
				expect(harness.server.callCount).toBe(1)
				expect(result.unwrapValue()).toBe(2)
			},
		)

		blockingTest(
			"supports wildcard request assertions for destination, method, and arguments",
			async ({ harness }) => {
				const handle = await harness.client.addOneThroughServer(1)

				expect(() =>
					handle.expectRequest({ to: "*", method: "addOne", args: [1] }),
				).not.toThrow()
				expect(() =>
					handle.expectRequest({ to: "server", method: "*", args: [1] }),
				).not.toThrow()
				expect(() =>
					handle.expectRequest({ to: "server", method: "addOne", args: "*" }),
				).not.toThrow()
				expect(harness.server.callCount).toBe(0)

				const result = await handle.allowRequest({
					to: "server",
					method: "addOne",
					args: [1],
				})

				expect(harness.server.callCount).toBe(1)
				expect(result.unwrapValue()).toBe(2)
			},
		)

		blockingTest(
			"can return a mocked value instead of calling the real dependency",
			async ({ harness }) => {
				const handle = await harness.client.addOneThroughServer(1)

				const result = await handle.mockReturnValue(42)
				expect(harness.server.callCount).toBe(0)
				expect(result.resolved).toBe(true)
				expect(result.unwrapValue()).toBe(42)
				await expect(
					handle.allowRequest({ to: "server", method: "addOne", args: [1] }),
				).rejects.toThrow("already")
			},
		)

		blockingTest(
			"can fail the blocked request with a supplied error",
			async ({ harness }) => {
				const handle = await harness.client.addOneThroughServer(1)

				await expect(handle.fail(new Error("boom"))).rejects.toThrow("boom")
				expect(harness.server.callCount).toBe(0)
			},
		)
	})

	describe("withUnlockedGates", () => {
		class Server {
			callCount = 0

			addOne(value: number): Promise<number> {
				this.callCount += 1
				return Promise.resolve(value + 1)
			}
		}

		class Client {
			constructor(private readonly server: Server) {}

			async addOneThroughServer(value: number): Promise<number> {
				return await this.server.addOne(value)
			}
		}

		const blockingTest = base.extend<{
			harness: ReturnType<
				GatekeeperBuilder<{ server: Server; client: Client }>["build"]
			>
		}>({
			harness: async ({}, use) => {
				await use(
					new GatekeeperBuilder()
						.add("server", () => new Server())
						.add("client", ({ server }) => new Client(server))
						.build(),
				)
			},
		})

		blockingTest(
			"returns raw async values inside the callback and applies mutations immediately",
			async ({ harness }) => {
				const result = await harness.withUnlockedGates(async ({ client }) => {
					const rawResult = client.addOneThroughServer(1)

					expect(harness.server.callCount).toBe(1)

					const value = await rawResult
					expect(value).toBe(2)

					return value
				})

				expect(result).toBe(2)
				expect(harness.server.callCount).toBe(1)
			},
		)

		blockingTest(
			"restores gated behavior after the callback finishes",
			async ({ harness }) => {
				await harness.withUnlockedGates(async ({ client }) => {
					expect(await client.addOneThroughServer(1)).toBe(2)
				})

				expect(harness.server.callCount).toBe(1)

				const handle = await harness.client.addOneThroughServer(2)

				expect(handle.resolved).toBe(false)
				handle.expectRequest({ to: "server", method: "addOne", args: [2] })
				expect(harness.server.callCount).toBe(1)

				const done = await handle.allowRequest({
					to: "server",
					method: "addOne",
					args: [2],
				})

				expect(harness.server.callCount).toBe(2)
				expect(done.unwrapValue()).toBe(3)
			},
		)

		blockingTest(
			"relocks even when the callback throws or rejects",
			async ({ harness }) => {
				await expect(
					harness.withUnlockedGates(({ client }) => {
						void client.addOneThroughServer(1)
						expect(harness.server.callCount).toBe(1)
						throw new Error("sync boom")
					}),
				).rejects.toThrow("sync boom")

				const afterSyncThrow = await harness.client.addOneThroughServer(2)
				afterSyncThrow.expectRequest({
					to: "server",
					method: "addOne",
					args: [2],
				})
				expect(harness.server.callCount).toBe(1)

				const firstDone = await afterSyncThrow.allowRequest({
					to: "server",
					method: "addOne",
					args: [2],
				})
				expect(firstDone.unwrapValue()).toBe(3)
				expect(harness.server.callCount).toBe(2)

				await expect(
					harness.withUnlockedGates(async ({ client }) => {
						expect(await client.addOneThroughServer(3)).toBe(4)
						throw new Error("async boom")
					}),
				).rejects.toThrow("async boom")
				expect(harness.server.callCount).toBe(3)

				const afterAsyncReject = await harness.client.addOneThroughServer(4)
				afterAsyncReject.expectRequest({
					to: "server",
					method: "addOne",
					args: [4],
				})
				expect(harness.server.callCount).toBe(3)

				const secondDone = await afterAsyncReject.allowRequest({
					to: "server",
					method: "addOne",
					args: [4],
				})

				expect(secondDone.unwrapValue()).toBe(5)
				expect(harness.server.callCount).toBe(4)
			},
		)
	})

	describe("when a workflow makes multiple downstream requests", () => {
		class WorkflowServer {
			callLog: string[] = []

			stepOne(value: number): Promise<number> {
				this.callLog.push(`stepOne:${value}`)
				return Promise.resolve(value + 1)
			}

			stepTwo(value: number): Promise<number> {
				this.callLog.push(`stepTwo:${value}`)
				return Promise.resolve(value + 1)
			}
		}

		class WorkflowClient {
			constructor(private readonly server: WorkflowServer) {}

			format(value: number): number {
				return value + 1
			}

			async doTwoCalls(value: number): Promise<number> {
				const first = await this.server.stepOne(value)
				return await this.server.stepTwo(first)
			}

			async fanOut(value: number): Promise<number> {
				const [first, second] = await Promise.all([
					this.server.stepOne(value),
					this.server.stepTwo(value + 1),
				])

				return first + second
			}
		}

		const workflowTest = base.extend<{
			harness: ReturnType<
				GatekeeperBuilder<{
					server: WorkflowServer
					client: WorkflowClient
				}>["build"]
			>
		}>({
			harness: async ({}, use) => {
				await use(
					new GatekeeperBuilder()
						.add("server", () => new WorkflowServer())
						.add("client", ({ server }) => new WorkflowClient(server))
						.build(),
				)
			},
		})

		workflowTest(
			"hands the test from the first blocked request to the next one and then finishes with a resolved handle",
			async ({ harness }) => {
				const first = await harness.client.doTwoCalls(1)

				first.expectRequest({ to: "server", method: "stepOne", args: [1] })

				const second = await first.allowRequest({
					to: "server",
					method: "stepOne",
					args: [1],
				})

				expect(harness.server.callLog).toEqual(["stepOne:1"])
				expect(second.resolved).toBe(false)
				expect(() =>
					second.expectRequest({ to: "server", method: "stepTwo", args: [2] }),
				).not.toThrow()

				const done = await second.allowRequest({
					to: "server",
					method: "stepTwo",
					args: [2],
				})

				expect(harness.server.callLog).toEqual(["stepOne:1", "stepTwo:2"])
				expect(done.resolved).toBe(true)
				expect(done.unwrapValue()).toBe(3)
			},
		)

		workflowTest(
			"does not clobber a blocked invocation when an unrelated sync harness method runs",
			async ({ harness }) => {
				const first = await harness.client.doTwoCalls(1)

				first.expectRequest({ to: "server", method: "stepOne", args: [1] })

				expect(harness.client.format(10)).toBe(11)

				const second = await first.allowRequest({
					to: "server",
					method: "stepOne",
					args: [1],
				})

				expect(harness.server.callLog).toEqual(["stepOne:1"])
				expect(second.resolved).toBe(false)
				second.expectRequest({ to: "server", method: "stepTwo", args: [2] })

				const done = await second.allowRequest({
					to: "server",
					method: "stepTwo",
					args: [2],
				})

				expect(harness.server.callLog).toEqual(["stepOne:1", "stepTwo:2"])
				expect(done.resolved).toBe(true)
				expect(done.unwrapValue()).toBe(3)
			},
		)

		workflowTest(
			"fails fast when a workflow fans out to multiple blocked downstream calls at once",
			async ({ harness }) => {
				const handle = await harness.client.fanOut(1)

				handle.expectRequest({ to: "server", method: "stepOne", args: [1] })

				await expect(
					handle.allowRequest({ to: "server", method: "stepOne", args: [1] }),
				).rejects.toThrow("Gatekeeper v1 only supports serial downstream calls")
				expect(harness.server.callLog).toEqual([])
			},
		)
	})

	describe("when services expose nested objects", () => {
		class NestedRemote {
			callLog: string[] = []

			advanceCursor(value: number): Promise<number> {
				this.callLog.push(`advanceCursor:${value}`)
				return Promise.resolve(value + 1)
			}

			math = {
				double: async (value: number): Promise<number> => {
					this.callLog.push(`double:${value}`)
					return value * 2
				},
			}
		}

		class SyncLayer {
			label = "sync-layer"

			constructor(private readonly remote: NestedRemote) {}

			format(value: number): number {
				return value + 100
			}

			async advanceCursor(value: number): Promise<number> {
				return await this.remote.advanceCursor(value)
			}

			async doubleViaRemoteMath(value: number): Promise<number> {
				return await this.remote.math.double(value)
			}
		}

		class NestedClient {
			label = "client"
			ready = Promise.resolve()
			sync: SyncLayer

			constructor(remote: NestedRemote) {
				this.sync = new SyncLayer(remote)
			}

			format(value: number): number {
				return value + 1
			}
		}

		const nestedTest = base.extend<{
			harness: ReturnType<
				GatekeeperBuilder<{
					remote: NestedRemote
					client: NestedClient
				}>["build"]
			>
		}>({
			harness: async ({}, use) => {
				await use(
					new GatekeeperBuilder()
						.add("remote", () => new NestedRemote())
						.add("client", ({ remote }) => new NestedClient(remote))
						.build(),
				)
			},
		})

		nestedTest(
			"preserves sync properties and sync methods on nested objects",
			async ({ harness }) => {
				expect(harness.client.label).toBe("client")
				expect(harness.client.format(1)).toBe(2)
				expect(harness.client.sync.label).toBe("sync-layer")
				expect(harness.client.sync.format(1)).toBe(101)
				await expect(harness.client.ready).resolves.toBeUndefined()
			},
		)

		nestedTest(
			"supports direct nested async access from the harness",
			async ({ harness }) => {
				const handle = await harness.client.sync.advanceCursor(1)

				handle.expectRequest({
					to: "remote",
					method: "advanceCursor",
					args: [1],
				})
				expect(harness.remote.callLog).toEqual([])

				const done = await handle.allowRequest({
					to: "remote",
					method: "advanceCursor",
					args: [1],
				})

				expect(harness.remote.callLog).toEqual(["advanceCursor:1"])
				expect(done.unwrapValue()).toBe(2)
			},
		)

		nestedTest(
			"intercepts nested downstream method paths transitively",
			async ({ harness }) => {
				const handle = await harness.client.sync.doubleViaRemoteMath(3)

				handle.expectRequest({
					to: "remote",
					method: "math.double",
					args: [3],
				})
				expect(harness.remote.callLog).toEqual([])

				const done = await handle.allowRequest({
					to: "remote",
					method: "math.double",
					args: [3],
				})

				expect(harness.remote.callLog).toEqual(["double:3"])
				expect(done.unwrapValue()).toBe(6)
			},
		)
	})

	describe("when multiple top-level invocations are blocked concurrently", () => {
		class Server {
			callCount = 0

			addOne(value: number): Promise<number> {
				this.callCount += 1
				return Promise.resolve(value + 1)
			}
		}

		class Client {
			constructor(private readonly server: Server) {}

			async addOneThroughServer(value: number): Promise<number> {
				return await this.server.addOne(value)
			}
		}

		const blockingTest = base.extend<{
			harness: ReturnType<
				GatekeeperBuilder<{ server: Server; client: Client }>["build"]
			>
		}>({
			harness: async ({}, use) => {
				await use(
					new GatekeeperBuilder()
						.add("server", () => new Server())
						.add("client", ({ server }) => new Client(server))
						.build(),
				)
			},
		})

		blockingTest(
			"allows two blocked invocations to be resolved in reverse order",
			async ({ harness }) => {
				const aPromise = harness.client.addOneThroughServer(1)
				const bPromise = harness.client.addOneThroughServer(2)

				const [a, b] = await Promise.all([aPromise, bPromise])

				a.expectRequest({ to: "server", method: "addOne", args: [1] })
				b.expectRequest({ to: "server", method: "addOne", args: [2] })
				expect(harness.server.callCount).toBe(0)

				// Resolve B first
				const doneB = await b.allowRequest({
					to: "server",
					method: "addOne",
					args: [2],
				})
				expect(doneB.resolved).toBe(true)
				expect(doneB.unwrapValue()).toBe(3)
				expect(harness.server.callCount).toBe(1)

				// Then resolve A
				const doneA = await a.allowRequest({
					to: "server",
					method: "addOne",
					args: [1],
				})
				expect(doneA.resolved).toBe(true)
				expect(doneA.unwrapValue()).toBe(2)
				expect(harness.server.callCount).toBe(2)
			},
		)

		blockingTest(
			"resolves independently when two blocked invocations have identical request shapes",
			async ({ harness }) => {
				// Both calls produce identical blocked request shapes: addOne(1)
				const aPromise = harness.client.addOneThroughServer(1)
				const bPromise = harness.client.addOneThroughServer(1)

				const [a, b] = await Promise.all([aPromise, bPromise])

				a.expectRequest({ to: "server", method: "addOne", args: [1] })
				b.expectRequest({ to: "server", method: "addOne", args: [1] })

				// Mock one, allow the other — they must not cross
				const doneA = await a.mockReturnValue(42)
				expect(doneA.resolved).toBe(true)
				expect(doneA.unwrapValue()).toBe(42)
				expect(harness.server.callCount).toBe(0)

				const doneB = await b.allowRequest({
					to: "server",
					method: "addOne",
					args: [1],
				})
				expect(doneB.resolved).toBe(true)
				expect(doneB.unwrapValue()).toBe(2)
				expect(harness.server.callCount).toBe(1)
			},
		)

		base(
			"preserves transitive downstream attribution when A resumes before B",
			async () => {
				class StepServer {
					callLog: string[] = []

					stepOne(tag: string): Promise<string> {
						this.callLog.push(`stepOne:${tag}`)
						return Promise.resolve(`${tag}:1`)
					}

					stepTwo(tag: string): Promise<string> {
						this.callLog.push(`stepTwo:${tag}`)
						return Promise.resolve(`${tag}:2`)
					}
				}

				class StepClient {
					constructor(private readonly server: StepServer) {}

					async doTwoSteps(tag: string): Promise<string> {
						const first = await this.server.stepOne(tag)
						return await this.server.stepTwo(first)
					}
				}

				const harness = new GatekeeperBuilder()
					.add("server", () => new StepServer())
					.add("client", ({ server }) => new StepClient(server))
					.build()

				// Both A and B block on their first downstream call
				const aPromise = harness.client.doTwoSteps("a")
				const bPromise = harness.client.doTwoSteps("b")

				const [a, b] = await Promise.all([aPromise, bPromise])

				a.expectRequest({ to: "server", method: "stepOne", args: ["a"] })
				b.expectRequest({ to: "server", method: "stepOne", args: ["b"] })

				// Resume A first — its continuation must produce A's next handle, not B's
				const a2 = await a.allowRequest({
					to: "server",
					method: "stepOne",
					args: ["a"],
				})

				expect(a2.resolved).toBe(false)
				a2.expectRequest({ to: "server", method: "stepTwo", args: ["a:1"] })

				// B is still blocked on stepOne
				b.expectRequest({ to: "server", method: "stepOne", args: ["b"] })

				// Finish both
				const doneA = await a2.allowRequest({
					to: "server",
					method: "stepTwo",
					args: ["a:1"],
				})
				expect(doneA.resolved).toBe(true)
				expect(doneA.unwrapValue()).toBe("a:1:2")

				const b2 = await b.allowRequest({
					to: "server",
					method: "stepOne",
					args: ["b"],
				})
				expect(b2.resolved).toBe(false)
				b2.expectRequest({ to: "server", method: "stepTwo", args: ["b:1"] })

				const doneB = await b2.allowRequest({
					to: "server",
					method: "stepTwo",
					args: ["b:1"],
				})
				expect(doneB.resolved).toBe(true)
				expect(doneB.unwrapValue()).toBe("b:1:2")

				expect(harness.server.callLog).toEqual([
					"stepOne:a",
					"stepTwo:a:1",
					"stepOne:b",
					"stepTwo:b:1",
				])
			},
		)
	})

	describe("when an invocation settles while a blocked handle is still active", () => {
		// Models a client operation that validates preconditions after initiating
		// a downstream request — e.g. a push that starts sending mutations to the
		// server, then discovers a local constraint violation and aborts before
		// the server responds.  The downstream call is still blocked when the
		// invocation rejects; the test must be able to observe that rejection
		// through the blocked handle rather than accidentally forwarding the call.

		base(
			"surfaces the invocation error through the blocked handle instead of forwarding the call",
			async () => {
				class Remote {
					pushCount = 0

					push(mutations: unknown[]): Promise<{ cursor: number }> {
						this.pushCount += 1
						return Promise.resolve({ cursor: mutations.length })
					}
				}

				class SyncEngine {
					constructor(private readonly remote: Remote) {}

					async pushMutations(
						mutations: unknown[],
					): Promise<{ cursor: number }> {
						// Initiate the push — this creates the blocked handle
						const inflight = this.remote.push(mutations)
						void inflight.then(
							() => {},
							() => {},
						)

						// Discover a constraint violation after the push is in flight
						if (mutations.some((m) => m === null)) {
							throw new Error("null mutation: aborting push")
						}

						return await inflight
					}
				}

				const harness = new GatekeeperBuilder()
					.add("remote", () => new Remote())
					.add("engine", ({ remote }) => new SyncEngine(remote))
					.build()

				// Push with a null mutation — the engine will abort after starting the push
				const handle = await harness.engine.pushMutations(["ok", null])

				expect(handle.resolved).toBe(false)
				handle.expectRequest({
					to: "remote",
					method: "push",
					args: [["ok", null]],
				})

				// The invocation already rejected — allowRequest surfaces that error
				await expect(
					handle.allowRequest({
						to: "remote",
						method: "push",
						args: [["ok", null]],
					}),
				).rejects.toThrow("null mutation: aborting push")

				// The remote was never actually called
				expect(harness.remote.pushCount).toBe(0)
			},
		)
	})

	describe("when detached background work outlives its invocation", () => {
		// Models a sync engine that kicks off background cache pre-warming during
		// a pull.  The pull completes and the invocation is cleaned up, but the
		// detached pre-warm work later tries to call a gated dependency.  Without
		// the invariant check the call would bypass gating entirely (no invocation
		// in the map → direct passthrough), silently producing an ungated side
		// effect.  The invariant ensures this is caught as a bug.

		base("throws the invariant error instead of bypassing gating", async () => {
			class Remote {
				callCount = 0

				fetchUpdates(): Promise<string[]> {
					this.callCount += 1
					return Promise.resolve(["update-1"])
				}
			}

			let triggerPreWarm!: () => void
			let preWarmResult!: Promise<unknown>

			class SyncEngine {
				constructor(private readonly remote: Remote) {}

				async pull(): Promise<string> {
					const trigger = new Promise<void>((r) => {
						triggerPreWarm = r
					})

					// Kick off background cache pre-warming that will fire later.
					// The .then() inherits the current invocation's ALS context.
					preWarmResult = trigger.then(async () => {
						return await this.remote.fetchUpdates()
					})
					preWarmResult.catch(() => {})

					return "pull complete"
				}
			}

			const harness = new GatekeeperBuilder()
				.add("remote", () => new Remote())
				.add("engine", ({ remote }) => new SyncEngine(remote))
				.build()

			const handle = await harness.engine.pull()
			expect(handle.resolved).toBe(true)
			expect(handle.unwrapValue()).toBe("pull complete")

			// The pull invocation is done and cleaned up.
			// Now the detached pre-warm fires — it should fail, not bypass gating.
			triggerPreWarm()
			await expect(preWarmResult).rejects.toThrow("no longer live")

			// The remote was never called — the invariant prevented an ungated call
			expect(harness.remote.callCount).toBe(0)
		})
	})
})
