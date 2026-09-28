import { readdirSync, readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"
import { type DstRunOptions, DstSimulation } from "./DstSimulation.js"

type KnownFailure = {
	options: DstRunOptions
	result: Awaited<ReturnType<DstSimulation["execute"]>>
}

const knownFailuresDir = new URL("./known-failures/", import.meta.url)

function knownFailure(name: string): KnownFailure {
	return JSON.parse(
		readFileSync(new URL(`${name}.json`, knownFailuresDir), "utf8"),
	) as KnownFailure
}

describe("Deterministic simulation testing", () => {
	it("converges with interleaved calls and no faults", async () => {
		const result = await new DstSimulation({ seed: 1, steps: 300 }).execute()

		expect(result.converged).toBe(true)
	})

	it("converges when requests, responses, and pokes are dropped", async () => {
		const result = await new DstSimulation({
			seed: 1,
			steps: 300,
			faultRate: 0.1,
		}).execute()

		expect(result.converged).toBe(true)
	})

	it("restarts crashed clients from their storage and converges", async () => {
		const result = await new DstSimulation({
			seed: 1,
			steps: 300,
			crashRate: 0.02,
		}).execute()

		expect(result.trace.filter(({ type }) => type === "crash")).not.toEqual([])
		expect(result.converged).toBe(true)
	})

	it("keeps several calls in flight at once", async () => {
		const result = await new DstSimulation({ seed: 1, steps: 300 }).execute()

		expect(result.maxPendingCalls).toBeGreaterThanOrEqual(2)
	})

	it("reproduces a run exactly from its seed, including every generated id", async () => {
		const options = { seed: 42, steps: 300, faultRate: 0.1 }

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

	// Each recording must reproduce exactly. A mismatch means the simulation
	// changed and the recording must be re-recorded, or the bug was fixed.
	it("reproduces every recorded known failure", async () => {
		const names = readdirSync(knownFailuresDir)
			.filter((file) => file.endsWith(".json"))
			.map((file) => file.replace(/\.json$/, ""))

		for (const name of names) {
			const { options, result } = knownFailure(name)

			expect(await new DstSimulation(options).execute(), name).toEqual(result)
		}
	})

	// Known sync bugs, documented in known-failures/README.md. Each test starts
	// failing once its bug is fixed; then drop `.fails` and the recording.
	describe("known sync bugs", () => {
		it.fails("an empty patch keeps its acknowledgement", async () => {
			const { options } = knownFailure("seed-2-empty-patch-drops-ack")

			expect((await new DstSimulation(options).execute()).converged).toBe(true)
		})

		it.fails("a record deleted after its creator pushed it leaves that creator", async () => {
			const { options } = knownFailure("seed-102-pushed-keys-not-synced")

			expect((await new DstSimulation(options).execute()).converged).toBe(true)
		})

		it.fails("a lost push response keeps writes the server accepted", async () => {
			const { options } = knownFailure("seed-288-lost-response-rollback")

			expect((await new DstSimulation(options).execute()).converged).toBe(true)
		})

		it.fails("a crash before a write is pushed still pushes it after restart", async () => {
			const { options } = knownFailure("seed-25-crash-loses-outbox")

			expect((await new DstSimulation(options).execute()).converged).toBe(true)
		})
	})
})
