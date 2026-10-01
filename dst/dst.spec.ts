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
	it("converges to the server with interleaved calls and no faults", async () => {
		const result = await new DstSimulation({ seed: 3, steps: 300 }).execute()

		expect(result.violation).toBeUndefined()
		expect(result.states.client1).toEqual(result.states.server)
		expect(result.states.client2).toEqual(result.states.server)
	})

	it("settles a final lost request by reconnecting and delivering retained writes", async () => {
		const result = await new DstSimulation({
			seed: 2,
			steps: 6,
			faultRate: 0.1,
		}).execute()
		expect(result.trace.at(-1)).toMatchObject({
			type: "drop",
			fault: "requestLost",
		})
		expect(result.violation).toBeUndefined()
		expect(result.states.server).toEqual([
			{ id: "item-3", text: "Note item-3 (rev 3)", done: true, priority: 1 },
		])
		expect(result.states.client1).toEqual(result.states.server)
		expect(result.states.client2).toEqual(result.states.server)
		expect(result.stepsCompleted).toBe(6)
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

	it("replays a fault-and-crash run to the same final outcome", async () => {
		const sink = memorySink()
		const run = await new DstSimulation({
			seed: 2,
			steps: 300,
			faultRate: 0.1,
			crashRate: 0.02,
		}).execute(sink)

		const replayed = await replay(parseArtifact(formatArtifact(sink.lines)))

		expect(replayed).toEqual({
			stepsCompleted: run.stepsCompleted,
			violation: run.violation,
			divergence: undefined,
		})
	})

	it("reports where a replay leaves the recorded path", async () => {
		const artifact = parseArtifact(
			readFileSync(
				new URL("./regressions/lost-push.jsonl", import.meta.url),
				"utf8",
			),
		)
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

	it("removes artifacts for converged fault runs", async () => {
		const outDir = mkdtempSync(join(tmpdir(), "dst-sweep-"))
		onTestFinished(() => rmSync(outDir, { recursive: true }))

		// These seeds lost writes under the former rollback behavior.
		const results = await sweep({
			seed: 1,
			steps: 10,
			faultRate: 0.1,
			runs: 4,
			outDir,
		})

		expect(results.map(({ seed, outcome }) => ({ seed, outcome }))).toEqual([
			{ seed: 1, outcome: "ok" },
			{ seed: 2, outcome: "ok" },
			{ seed: 3, outcome: "ok" },
			{ seed: 4, outcome: "ok" },
		])
		expect(readdirSync(outDir)).toEqual([])
	})

	it("replays the original lost-push trace without a convergence violation", async () => {
		const artifact = parseArtifact(
			readFileSync(
				new URL("./regressions/lost-push.jsonl", import.meta.url),
				"utf8",
			),
		)
		expect(await replay(artifact)).toEqual({
			stepsCompleted: 6,
			violation: undefined,
			divergence: undefined,
		})
	})

	// Known sync bugs, documented in known-failures/README.md. Each replay must
	// still reach its recorded violation. When a bug is fixed, or the recording
	// no longer applies, the test fails; then delete the recording.
	describe("known sync bugs", () => {
		it.each([
			[
				"a persisted optimistic record survives final pulls but is absent from the server",
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
