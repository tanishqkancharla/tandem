import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it, onTestFinished } from "vitest"
import { sweep } from "./DstCli.js"
import {
	type DstArtifact,
	formatArtifact,
	memorySink,
	parseArtifact,
	replay,
} from "./DstReplay.js"
import { DstSimulation } from "./DstSimulation.js"

function knownFailure(name: string): DstArtifact {
	return parseArtifact(
		readFileSync(new URL(`./known-failures/${name}.jsonl`, import.meta.url), {
			encoding: "utf8",
		}),
	)
}

describe("Deterministic simulation testing", () => {
	it("agrees with the reference model with interleaved calls and no faults", async () => {
		const result = await new DstSimulation({ seed: 3, steps: 300 }).execute()

		expect(result.violation).toBeUndefined()
	})

	it("stops at the first step a client disagrees with the model", async () => {
		const { options } = knownFailure("seed-2-lost-push-rolls-back")

		const result = await new DstSimulation(options).execute()

		expect(result.violation).toMatchObject({
			kind: "clientState",
			step: 3,
			client: "client2",
			actual: [],
		})
		expect(result.stepsCompleted).toBe(4)
		expect(result.trace.at(-1)?.step).toBe(3)
	})

	it("restarts crashed clients from their storage and converges", async () => {
		const result = await new DstSimulation({
			seed: 3,
			steps: 300,
			crashRate: 0.02,
		}).execute()

		expect(result.trace.filter(({ type }) => type === "crash")).not.toEqual([])
		expect(result.violation).toBeUndefined()
	})

	it("keeps several calls in flight at once", async () => {
		const result = await new DstSimulation({ seed: 3, steps: 300 }).execute()

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

	it("replays a failing run's artifact to the same violation", async () => {
		const sink = memorySink()
		const run = await new DstSimulation({
			seed: 2,
			steps: 300,
			faultRate: 0.1,
			crashRate: 0.02,
		}).execute(sink)

		const replayed = await replay(parseArtifact(formatArtifact(sink.lines)))

		expect(run.violation).toBeDefined()
		expect(replayed).toEqual({
			stepsCompleted: run.stepsCompleted,
			violation: run.violation,
			divergence: undefined,
		})
	})

	it("reports where a replay leaves the recorded path", async () => {
		const artifact = knownFailure("seed-2-lost-push-rolls-back")
		const advance = artifact.trace.find(({ type }) => type === "advance")!
		const altered: DstArtifact = {
			...artifact,
			trace: artifact.trace.map((record) =>
				record === advance ? { ...record, call: "client2.commit#9" } : record,
			),
		}

		const replayed = await replay(altered)

		expect(replayed.divergence).toMatchObject({
			step: advance.step,
			reason: "client2.commit#9 is not held at a boundary",
		})
	})

	it("sweeps seeds, keeping and replaying artifacts only for failing runs", async () => {
		const outDir = mkdtempSync(join(tmpdir(), "dst-sweep-"))
		onTestFinished(() => rmSync(outDir, { recursive: true }))

		// Seeds 1 and 2 hit bug C, a lost push treated as a rejection.
		const results = await sweep({
			seed: 1,
			steps: 10,
			faultRate: 0.1,
			runs: 4,
			outDir,
		})

		expect(results.map(({ seed, outcome }) => ({ seed, outcome }))).toEqual([
			{ seed: 1, outcome: "violation" },
			{ seed: 2, outcome: "violation" },
			{ seed: 3, outcome: "ok" },
			{ seed: 4, outcome: "ok" },
		])
		expect(readdirSync(outDir).sort()).toEqual(["seed-1.jsonl", "seed-2.jsonl"])
	})

	// Known sync bugs, documented in known-failures/README.md. Each replay must
	// still reach its recorded violation. When a bug is fixed, or the recording
	// no longer applies, the test fails; then delete the recording.
	describe("known sync bugs", () => {
		it.each([
			[
				"C: a push that fails in transit is treated as a rejection",
				"seed-2-lost-push-rolls-back",
			],
			[
				"D: a crash loses writes that were stored but not pushed",
				"seed-13-crash-loses-outbox",
			],
		])("%s", async (_bug, name) => {
			const artifact = knownFailure(name)

			const replayed = await replay(artifact)

			expect(replayed.divergence).toBeUndefined()
			expect(replayed.violation).toEqual(artifact.outcome?.violation)
		})
	})
})
