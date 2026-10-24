import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"
import {
	parseTabArtifact,
	replayTabs,
	type TabCoverage,
	TabSimulation,
	tabMemorySink,
	TabWorld,
} from "./TabSimulation.js"

/** Advances the oldest pending step, skipping held ones, until `done` holds. */
async function advanceUntil(
	world: TabWorld,
	done: () => boolean,
	held: (call: string) => boolean = () => false,
) {
	let step = 0
	while (!done()) {
		const next = world.pending().find(({ name }) => !held(name))
		if (!next) throw new Error("nothing left to advance")
		world.apply(step++, { type: "advance", call: next.name })
		await world.settle()
		if (step > 2_000) throw new Error("condition never held")
	}
}

async function sweep(options: {
	faultRate?: number
	saveFaultRate?: number
	crashRate?: number
}) {
	const coverage: TabCoverage = {
		takeoversWithPendingCommits: 0,
		acceptedPushRepliesLost: 0,
		failedSaves: 0,
		serverCompletions: 0,
		failedRestores: 0,
	}
	for (let seed = 1; seed <= 20; seed++) {
		const result = await new TabSimulation({
			seed,
			steps: 300,
			...options,
		}).execute()
		expect(result.violation, `seed ${seed}`).toBeUndefined()
		for (const key of Object.keys(coverage) as (keyof TabCoverage)[])
			coverage[key] += result.coverage[key]
	}
	return coverage
}

describe("Shared tab deterministic simulation", () => {
	it("keeps completed writes on the server through lost replies and leader crashes", async () => {
		const coverage = await sweep({ faultRate: 0.1, crashRate: 0.02 })

		// Passing seeds only count if they reached the situations under test.
		expect(coverage.acceptedPushRepliesLost).toBeGreaterThan(0)
		expect(coverage.takeoversWithPendingCommits).toBeGreaterThan(0)
		expect(coverage.serverCompletions).toBeGreaterThan(0)
	})

	it("resends writes whose leader save failed, including across leader crashes", async () => {
		const coverage = await sweep({ saveFaultRate: 0.05, crashRate: 0.02 })

		expect(coverage.failedSaves).toBeGreaterThan(0)
		expect(coverage.takeoversWithPendingCommits).toBeGreaterThan(0)
	})

	it("replays a run to the same outcome, and other seeds differ", async () => {
		const options = {
			seed: 4,
			steps: 300,
			faultRate: 0.1,
			saveFaultRate: 0.05,
			crashRate: 0.02,
		}
		const sink = tabMemorySink()
		const run = await new TabSimulation(options).execute(sink)
		const other = await new TabSimulation({ ...options, seed: 5 }).execute()

		const replayed = await replayTabs(
			parseTabArtifact(
				sink.lines.map((line) => `${JSON.stringify(line)}\n`).join(""),
			),
		)

		expect(replayed).toEqual({
			outcome: {
				violation: run.violation,
				coverage: run.coverage,
				server: run.server,
			},
		})
		expect(other.trace).not.toEqual(run.trace)
	})

	// Each trace failed before its fix and replays cleanly after it.
	it.each([
		// A late announcement from the previous leader redirected a tab to it.
		"tabs-stale-leader",
		// A view published before the join reply was dropped and never resent.
		"tabs-view-before-join",
	])("replays the %s regression without a violation", async (name) => {
		const artifact = parseTabArtifact(
			readFileSync(
				new URL(`./regressions/${name}.jsonl`, import.meta.url),
				"utf8",
			),
		)
		const replayed = await replayTabs(artifact)
		expect(replayed.divergence).toBeUndefined()
		expect(replayed.outcome?.violation).toBeUndefined()
	})

	it("completes a commit once after the server accepts it and the reply is lost in a takeover", async () => {
		await using world = TabWorld.start(1)
		await advanceUntil(world, () => world.writers.length === 2)
		world.apply(0, { type: "write", tab: "tab2" })
		await world.settle()

		// The leader's push reaches the server, but its reply is lost, then the leader crashes.
		const push = () =>
			world.pending().find(({ name }) => name.startsWith("tab1.push#"))
		await advanceUntil(world, () => push() !== undefined)
		world.apply(1, { type: "advance", call: push()!.name })
		await world.settle()
		const reply = () =>
			world.pending().find(({ name }) => name.startsWith("tab1.push.reply#"))
		await advanceUntil(world, () => reply() !== undefined)
		world.apply(2, { type: "fault", call: reply()!.name })
		world.apply(3, { type: "crash", tab: "tab1" })
		await world.settle()

		const outcome = await world.finish()
		expect(outcome.violation).toBeUndefined()
		expect(outcome.coverage.acceptedPushRepliesLost).toBe(1)
		expect(world.acknowledged("w1")).toBe(true)
		expect(outcome.server.map(({ id }) => id)).toEqual(["w1"])
	})

	it("completes a commit through the next leader when the leader crashes after saving it", async () => {
		await using world = TabWorld.start(1)
		await advanceUntil(world, () => world.writers.length === 2)
		world.apply(0, { type: "write", tab: "tab2" })
		await world.settle()

		// The forwarded write is durable, but the leader dies before tab2 hears back.
		await advanceUntil(world, () => world.saved("w1"))
		world.apply(1, { type: "crash", tab: "tab1" })
		await world.settle()
		expect(world.acknowledged("w1")).toBe(false)

		const outcome = await world.finish()
		expect(outcome.violation).toBeUndefined()
		expect(world.acknowledged("w1")).toBe(true)
		expect(outcome.server.map(({ id }) => id)).toEqual(["w1"])
	})

	it("resends a write whose leader save failed, ahead of newer writes, to the next leader", async () => {
		await using world = TabWorld.start(1)
		await advanceUntil(world, () => world.writers.length === 2)
		world.apply(0, { type: "write", tab: "tab2" })
		world.apply(1, { type: "write", tab: "tab2" })
		await world.settle()

		// The leader fails to save w1, and tab2 hears about it while w2 is still pending.
		const save = () =>
			world
				.pending()
				.find(({ kind, faultable }) => kind === "storage" && faultable)
		await advanceUntil(world, () => save() !== undefined)
		world.apply(2, { type: "fault", call: save()!.name })
		await world.settle()
		const saving = (call: string) => call.startsWith("tab1.save#")
		await advanceUntil(world, () => world.commitOf("w1") === "rejected", saving)
		expect(world.saved("w1")).toBe(false)
		expect(world.commitOf("w2")).toBe("pending")

		// The leader crashes holding w1 only in memory. The next leader has no marker
		// for tab2, so it accepts whichever write arrives first.
		world.apply(3, { type: "crash", tab: "tab1" })
		await world.settle()

		const outcome = await world.finish()
		expect(outcome.violation).toBeUndefined()
		expect(outcome.server.map(({ id }) => id)).toEqual(["w1", "w2"])
		expect(world.commitOf("w2")).toBe("completed")
	})

	it("holds a saved commit until the delayed first connection delivers it", async () => {
		await using world = TabWorld.start(1)
		const connecting = (call: string) => /\.connect#/.test(call)
		await advanceUntil(world, () => world.writers.length === 2, connecting)
		world.apply(0, { type: "write", tab: "tab2" })
		await world.settle()

		// Everything else runs, so the write is saved and shared, but not complete.
		await advanceUntil(
			world,
			() => world.pending().every(({ name }) => connecting(name)),
			connecting,
		)
		expect(world.saved("w1")).toBe(true)
		expect(world.acknowledged("w1")).toBe(false)

		const outcome = await world.finish()
		expect(outcome.violation).toBeUndefined()
		expect(world.acknowledged("w1")).toBe(true)
	})
})
