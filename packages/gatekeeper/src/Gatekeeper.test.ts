import { describe, expect, test } from "vitest"
import { Gatekeeper } from "./Gatekeeper.js"
import type { Handle, RequestMatcher } from "./Gatekeeper.js"

function compileTimeTypeAssertions(): void {
	type Services = {
		server: {
			callCount: number
			addOne(value: number): Promise<number>
		}
		client: {
			addOneThroughServer(value: number): Promise<number>
		}
	}

	const _serviceMatcher: RequestMatcher<Services> = {
		to: "server",
		method: "addOne",
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

	// @ts-expect-error invalid argument tuple for the selected method
	handle.expectRequest({ to: "server", method: "addOne", args: ["1"] })

	void _serviceMatcher
	void _serviceWildcardMatcher
	void _globalWildcardMatcher
	void _badServiceMatcher
	void _badMethodMatcher
}

void compileTimeTypeAssertions

describe("Gatekeeper", () => {
	describe("when a service call finishes without touching another service", () => {
		// A simple service with async methods and no downstream dependencies.
		class Counter {
			increment(value: number): Promise<number> {
				return Promise.resolve(value + 1)
			}
		}

		test("returns a resolved handle with the final value", async () => {
			const harness = new Gatekeeper()
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
			private server: Server
			constructor(server: Server) {
				this.server = server
			}

			async addOneThroughServer(value: number): Promise<number> {
				return await this.server.addOne(value)
			}
		}

		function buildHarness() {
			const server = new Server()

			const harness = new Gatekeeper()
				.add("server", () => server)
				.add("client", ({ server }) => new Client(server))
				.build()

			return { harness, server }
		}

		test("lets the test inspect the request before allowing it through", async () => {
			const { harness, server } = buildHarness()
			const handle = await harness.client.addOneThroughServer(1)

			expect(handle.resolved).toBe(false)
			expect(() => handle.unwrapValue()).toThrow()
			expect(() =>
				handle.expectRequest({ to: "server", method: "addOne", args: [1] }),
			).not.toThrow()
			expect(server.callCount).toBe(0)

			const result = await handle.allowRequest({
				to: "server",
				method: "addOne",
				args: [1],
			})

			expect(server.callCount).toBe(1)
			expect(result.resolved).toBe(true)
			expect(result.unwrapValue()).toBe(2)
		})

		test("intercepts async methods defined as instance properties", async () => {
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

			const server = new FieldServer()
			const harness = new Gatekeeper()
				.add("server", () => server)
				.add("client", ({ server }) => new FieldClient(server))
				.build()

			const handle = await harness.client.addOneThroughServer(1)

			expect(handle.resolved).toBe(false)
			handle.expectRequest({ to: "server", method: "addOne", args: [1] })
			expect(server.callCount).toBe(0)

			const result = await handle.allowRequest({
				to: "server",
				method: "addOne",
				args: [1],
			})

			expect(server.callCount).toBe(1)
			expect(result.unwrapValue()).toBe(2)
		})

			test("keeps the request blocked after a mismatched allowRequest() so the test can recover", async () => {
				const { harness, server } = buildHarness()
				const handle = await harness.client.addOneThroughServer(1)

				await expect(
					handle.allowRequest({
						to: "server",
						method: "subtractOne",
						args: [1],
					} as any),
				).rejects.toThrow("did not match")
			expect(server.callCount).toBe(0)

			const result = await handle.allowRequest({
				to: "server",
				method: "addOne",
				args: [1],
			})
			expect(server.callCount).toBe(1)
			expect(result.unwrapValue()).toBe(2)
		})

		test("supports wildcard request assertions for destination, method, and arguments", async () => {
			const { harness, server } = buildHarness()
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
			expect(server.callCount).toBe(0)

			const result = await handle.allowRequest({
				to: "server",
				method: "addOne",
				args: [1],
			})

			expect(server.callCount).toBe(1)
			expect(result.unwrapValue()).toBe(2)
		})

		test("can return a mocked value instead of calling the real dependency", async () => {
			const { harness, server } = buildHarness()
			const handle = await harness.client.addOneThroughServer(1)

			const result = await handle.mockReturnValue(42)
			expect(server.callCount).toBe(0)
			expect(result.resolved).toBe(true)
			expect(result.unwrapValue()).toBe(42)
			await expect(
				handle.allowRequest({ to: "server", method: "addOne", args: [1] }),
			).rejects.toThrow("already")
		})

		test("can fail the blocked request with a supplied error", async () => {
			const { harness, server } = buildHarness()
			const handle = await harness.client.addOneThroughServer(1)

			await expect(handle.fail(new Error("boom"))).rejects.toThrow("boom")
			expect(server.callCount).toBe(0)
		})
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
			private server: WorkflowServer

			constructor(server: WorkflowServer) {
				this.server = server
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

		function buildHarness() {
			const server = new WorkflowServer()

			const harness = new Gatekeeper()
				.add("server", () => server)
				.add(
					"client",
					({ server }: { server: WorkflowServer }) =>
						new WorkflowClient(server),
				)
				.build()

			return { harness, server }
		}

		test("hands the test from the first blocked request to the next one and then finishes with a resolved handle", async () => {
			const { harness, server } = buildHarness()
			const first = await harness.client.doTwoCalls(1)

			first.expectRequest({ to: "server", method: "stepOne", args: [1] })

			const second = await first.allowRequest({
				to: "server",
				method: "stepOne",
				args: [1],
			})

			expect(server.callLog).toEqual(["stepOne:1"])
			expect(second.resolved).toBe(false)
			expect(() =>
				second.expectRequest({ to: "server", method: "stepTwo", args: [2] }),
			).not.toThrow()

			const done = await second.allowRequest({
				to: "server",
				method: "stepTwo",
				args: [2],
			})

			expect(server.callLog).toEqual(["stepOne:1", "stepTwo:2"])
			expect(done.resolved).toBe(true)
			expect(done.unwrapValue()).toBe(3)
		})

		test("fails fast when a workflow fans out to multiple blocked downstream calls at once", async () => {
			const { harness, server } = buildHarness()
			const handle = await harness.client.fanOut(1)

			handle.expectRequest({ to: "server", method: "stepOne", args: [1] })

			await expect(
				handle.allowRequest({ to: "server", method: "stepOne", args: [1] }),
			).rejects.toThrow("Gatekeeper v1 only supports serial downstream calls")
			expect(server.callLog).toEqual([])
		})
	})
})
