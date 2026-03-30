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
})
