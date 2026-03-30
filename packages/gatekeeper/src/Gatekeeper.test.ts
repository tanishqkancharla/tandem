import { describe, expect, test } from "vitest"
import { Gatekeeper, type RequestMatcher } from "./Gatekeeper.js"

describe("Gatekeeper", () => {
	describe("Phase 2: no-interception invocation handle", () => {
		// A simple service with async methods and no downstream dependencies.
		class Counter {
			async increment(value: number): Promise<number> {
				return value + 1
			}

			async double(value: number): Promise<number> {
				return value * 2
			}
		}

		test("handle.unwrapValue() returns the resolved value when no downstream call occurs", async () => {
			const harness = new Gatekeeper()
				.add("counter", () => new Counter())
				.build()

			const handle = await harness.counter.increment(5)
			expect(handle.resolved).toBe(true)
			expect(handle.unwrapValue()).toBe(6)
		})

		test("harness supports multiple independent services", async () => {
			class Doubler {
				async double(value: number): Promise<number> {
					return value * 2
				}
			}

			const harness = new Gatekeeper()
				.add("counter", () => new Counter())
				.add("doubler", () => new Doubler())
				.build()

			const h1 = await harness.counter.increment(1)
			expect(h1.unwrapValue()).toBe(2)

			const h2 = await harness.doubler.double(3)
			expect(h2.unwrapValue()).toBe(6)
		})
	})

	describe("Phase 3: single-call interception and gate controls", () => {
		class Server {
			callCount = 0

			async addOne(value: number): Promise<number> {
				this.callCount += 1
				return value + 1
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

		const addOneRequest: RequestMatcher = {
			to: "server",
			method: "addOne",
			args: [1],
		}

		function buildHarness() {
			const server = new Server()

			const harness = new Gatekeeper()
				.add("server", () => server)
				.add("client", ({ server }: { server: Server }) => new Client(server))
				.build()

			return { harness, server }
		}

		test("expectRequest() succeeds for the blocked request and does not unblock the invocation", async () => {
			const { harness, server } = buildHarness()
			const handle = await harness.client.addOneThroughServer(1)

			expect(handle.resolved).toBe(false)
			expect(() => handle.unwrapValue()).toThrow()
			expect(() => handle.expectRequest(addOneRequest)).not.toThrow()
			expect(server.callCount).toBe(0)

			const result = await handle.mockReturnValue(2)
			expect(result.resolved).toBe(true)
			expect(result.unwrapValue()).toBe(2)
		})

		test("allowRequest() forwards to real implementation and resolves the invocation", async () => {
			const { harness, server } = buildHarness()
			const handle = await harness.client.addOneThroughServer(1)

			const result = await handle.allowRequest(addOneRequest)
			expect(server.callCount).toBe(1)
			expect(result.resolved).toBe(true)
			expect(result.unwrapValue()).toBe(2) // real server: 1 + 1
		})

		test("expectRequest() mismatch throws without unblocking the invocation", async () => {
			const { harness, server } = buildHarness()
			const handle = await harness.client.addOneThroughServer(1)

			expect(() =>
				handle.expectRequest({ to: "server", method: "subtractOne", args: [1] })
			).toThrow("did not match")
			expect(server.callCount).toBe(0)

			const result = await handle.mockReturnValue(10)
			expect(result.unwrapValue()).toBe(10)
		})

		test("mismatched allowRequest() throws and the blocked invocation can still be resumed", async () => {
			const { harness, server } = buildHarness()
			const handle = await harness.client.addOneThroughServer(1)

			await expect(
				handle.allowRequest({ to: "server", method: "subtractOne", args: [1] })
			).rejects.toThrow("did not match")
			expect(server.callCount).toBe(0)

			const result = await handle.allowRequest(addOneRequest)
			expect(server.callCount).toBe(1)
			expect(result.unwrapValue()).toBe(2)
		})

		test.each([
			{
				name: "to",
				matcher: { to: "*", method: "addOne", args: [1] } satisfies RequestMatcher,
			},
			{
				name: "method",
				matcher: { to: "server", method: "*", args: [1] } satisfies RequestMatcher,
			},
			{
				name: "args",
				matcher: { to: "server", method: "addOne", args: "*" } satisfies RequestMatcher,
			},
		])(
			"allowRequest() accepts '*' as a wildcard for $name",
			async ({ matcher }: { matcher: RequestMatcher }) => {
				const { harness, server } = buildHarness()
				const handle = await harness.client.addOneThroughServer(1)

				const result = await handle.allowRequest(matcher)
				expect(server.callCount).toBe(1)
				expect(result.unwrapValue()).toBe(2)
			}
		)

		test("mockReturnValue() bypasses real implementation", async () => {
			const { harness, server } = buildHarness()
			const handle = await harness.client.addOneThroughServer(1)

			const result = await handle.mockReturnValue(42)
			expect(server.callCount).toBe(0)
			expect(result.resolved).toBe(true)
			expect(result.unwrapValue()).toBe(42)
		})

		test("fail() rejects the invocation with the supplied error", async () => {
			const { harness, server } = buildHarness()
			const handle = await harness.client.addOneThroughServer(1)

			await expect(handle.fail(new Error("boom"))).rejects.toThrow("boom")
			expect(server.callCount).toBe(0)
		})

		test("gate controls can only be called once", async () => {
			const { harness } = buildHarness()
			const handle = await harness.client.addOneThroughServer(1)

			await handle.mockReturnValue(42)

			await expect(handle.mockReturnValue(99)).rejects.toThrow("already")
			await expect(handle.allowRequest(addOneRequest)).rejects.toThrow("already")
			await expect(handle.fail(new Error("late"))).rejects.toThrow("already")
		})
	})
})
