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

	it("reproduces a run exactly from its seed, including every generated id", async () => {
		const options = { seed: 42, steps: 30, faultRate: 0.1 }

		const first = await new DstSimulation(options).execute()
		const second = await new DstSimulation(options).execute()
		const otherSeed = await new DstSimulation({
			...options,
			seed: 43,
		}).execute()

		expect(second).toEqual(first)
		expect(otherSeed.trace).not.toEqual(first.trace)
		expect(otherSeed.clientIds).not.toEqual(first.clientIds)
	})
})
