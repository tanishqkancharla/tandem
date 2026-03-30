import { describe, expect, test } from "vitest"
import { Gatekeeper } from "./Gatekeeper.js"

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
			async addOne(value: number): Promise<number> {
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

		function buildHarness() {
			return new Gatekeeper()
				.add("server", () => new Server())
				.add("client", ({ server }: { server: Server }) => new Client(server))
				.build()
		}

		test("await resolves to a blocked handle with call metadata when method hits a downstream call", async () => {
			const harness = buildHarness()
			const handle = await harness.client.addOneThroughServer(1)

			expect(handle.resolved).toBe(false)
			expect(handle.service).toBe("server")
			expect(handle.method).toBe("addOne")
			expect(handle.args).toEqual([1])
			expect(() => handle.unwrapValue()).toThrow()

			// clean up
			await handle.mockReturnValue(2)
		})

		test("allow() forwards to real implementation and resolves the invocation", async () => {
			const harness = buildHarness()
			const handle = await harness.client.addOneThroughServer(1)

			const result = await handle.allow()
			expect(result.resolved).toBe(true)
			expect(result.unwrapValue()).toBe(2) // real server: 1 + 1
		})

		test("mockReturnValue() bypasses real implementation", async () => {
			const harness = buildHarness()
			const handle = await harness.client.addOneThroughServer(1)

			const result = await handle.mockReturnValue(42)
			expect(result.resolved).toBe(true)
			expect(result.unwrapValue()).toBe(42)
		})

		test("fail() rejects the invocation with the supplied error", async () => {
			const harness = buildHarness()
			const handle = await harness.client.addOneThroughServer(1)

			await expect(handle.fail(new Error("boom"))).rejects.toThrow("boom")
		})

		test("gate controls can only be called once", async () => {
			const harness = buildHarness()
			const handle = await harness.client.addOneThroughServer(1)

			await handle.mockReturnValue(42)

			await expect(handle.mockReturnValue(99)).rejects.toThrow("already")
			await expect(handle.allow()).rejects.toThrow("already")
			await expect(handle.fail(new Error("late"))).rejects.toThrow("already")
		})
	})
})
