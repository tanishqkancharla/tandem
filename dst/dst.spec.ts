import { describe, expect, it } from "vitest"
import { DstSimulation } from "./DstSimulation.js"

describe("Deterministic Simulation Testing (DST)", () => {
	it("reaches eventual consistency across 50 simulated steps with random interleavings", async () => {
		const sim = new DstSimulation({
			seed: 12345,
			steps: 50,
			faultRate: 0,
		})

		const result = await sim.execute()
		expect(result.converged).toBe(true)
	})

	it("remains consistent when random network/push faults are injected", async () => {
		const sim = new DstSimulation({
			seed: 67890,
			steps: 60,
			faultRate: 0.1, // 10% fault injection
		})

		const result = await sim.execute()
		expect(result.converged).toBe(true)
	})

	it("produces identical execution traces with the same seed", async () => {
		const sim1 = new DstSimulation({ seed: 42, steps: 30 })
		const result1 = await sim1.execute()

		const sim2 = new DstSimulation({ seed: 42, steps: 30 })
		const result2 = await sim2.execute()

		expect(result1.trace).toEqual(result2.trace)
		expect(result1.finalCount).toBe(result2.finalCount)
	})
})
