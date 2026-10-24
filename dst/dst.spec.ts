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
import { DstWorld, serverOwnedIds } from "./DstWorld.js"

describe("Deterministic simulation testing", () => {
	it.each([0, 2])(
		"converges to the server with interleaved calls, no faults, and %i tabs",
		async (tabs) => {
			const result = await new DstSimulation({
				seed: 3,
				steps: 300,
				tabs,
			}).execute()

			expect(result.violation).toBeUndefined()
			expect(result.states.client1).toEqual(result.states.server)
			expect(result.states.client2).toEqual(result.states.server)
			for (const todos of Object.values(result.states.tabs ?? {}))
				expect(todos).toEqual(result.states.server)
		},
	)

	it.each(["client1", "client2"] as const)(
		"preserves disjoint offline field updates when %s edits completion",
		async (completionClient) => {
			await using world = await DstWorld.start(2)
			await world.apply(0, {
				type: "set",
				client: "client1",
				item: { id: "shared", text: "Original", done: false, priority: 3 },
			})
			// Both clients receive the base and disconnect before editing it.
			await world.finish()
			await world.apply(1, {
				type: "update",
				client: completionClient,
				id: "shared",
				payload: { done: true, priority: 8 },
			})
			await world.apply(2, {
				type: "update",
				client: completionClient === "client1" ? "client2" : "client1",
				id: "shared",
				payload: { text: "Concurrent title" },
			})

			const result = await world.finish()
			// Convergence alone would also pass if the server replaced the whole record.
			expect(result.states.server).toEqual([
				{ id: "shared", text: "Concurrent title", done: true, priority: 8 },
			])
			expect(result.violation).toBeUndefined()
			expect(result.states.client1).toEqual(result.states.server)
			expect(result.states.client2).toEqual(result.states.server)
		},
	)

	it("settles a final lost request by reconnecting and delivering retained writes", async () => {
		await using world = await DstWorld.start(2)
		const item = {
			id: "item-3",
			text: "Retained write",
			done: true,
			priority: 1,
		}
		await world.apply(0, { type: "set", client: "client1", item })
		await world.settle()

		// Finish local checkpointing and stop at the first outbound push.
		let step = 1
		while (
			world.pending().find(({ name }) => name === "client1.commit#1")
				?.waitingFor !== "server"
		) {
			await world.apply(step++, { type: "advance", call: "client1.commit#1" })
			await world.settle()
		}
		const dropped = await world.apply(step, {
			type: "drop",
			call: "client1.commit#1",
		})
		expect(dropped).toMatchObject({
			type: "drop",
			fault: "requestLost",
		})

		// Healthy reconnection delivers the retained write, not just an empty converged view.
		const result = await world.finish()
		expect(result.violation).toBeUndefined()
		expect(result.states.server).toEqual([item])
		expect(result.states.client1).toEqual(result.states.server)
		expect(result.states.client2).toEqual(result.states.server)
	})

	it.each([0, 2])(
		"restarts crashed clients and tabs from their storage and converges with %i tabs",
		async (tabs) => {
			const result = await new DstSimulation({
				seed: 3,
				steps: 300,
				crashRate: 0.02,
				tabs,
			}).execute()

			expect(result.trace.filter(({ type }) => type === "crash")).not.toEqual(
				[],
			)
			expect(result.violation).toBeUndefined()
		},
	)

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

	it("streams server writes under lost pokes without moving server-owned records backwards", async () => {
		const result = await new DstSimulation({
			seed: 7,
			steps: 300,
			faultRate: 0.1,
			crashRate: 0.02,
		}).execute()

		expect(
			result.trace.filter(
				(record) =>
					record.type === "serverSet" &&
					serverOwnedIds.includes(record.item.id),
			).length,
		).toBeGreaterThan(5)
		expect(
			result.trace.some(
				(record) => record.type === "drop" && record.fault === "pokeLost",
			),
		).toBe(true)
		expect(result.violation).toBeUndefined()
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

		const updates = run.trace.filter((record) => record.type === "update")
		expect(updates.length).toBeGreaterThan(0)
		const fieldCounts = updates.map(
			({ payload }) => Object.keys(payload).length,
		)
		expect(fieldCounts).toContain(1)
		expect(fieldCounts).toContain(2)
		for (const { payload } of updates) {
			expect(payload).not.toHaveProperty("id")
			expect(Object.keys(payload).length).toBeLessThan(3)
		}
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

	it("replays the lost-push trace through checkpointing without a convergence violation", async () => {
		const artifact = parseArtifact(
			readFileSync(
				new URL("./regressions/lost-push.jsonl", import.meta.url),
				"utf8",
			),
		)
		expect(await replay(artifact)).toEqual({
			stepsCompleted: 12,
			violation: undefined,
			divergence: undefined,
		})
	})

	it("replays the crash trace and delivers the durable optimistic write", async () => {
		const artifact = parseArtifact(
			readFileSync(
				new URL("./regressions/crash-ghost.jsonl", import.meta.url),
				"utf8",
			),
		)
		expect(await replay(artifact)).toEqual({
			stepsCompleted: 6,
			violation: undefined,
			divergence: undefined,
		})

		// Convergence alone could pass by discarding the write. Check delivery too.
		await using world = await DstWorld.start(artifact.options.seed)
		for (const event of artifact.trace) {
			world.pending()
			await world.apply(event.step, event)
			await world.settle()
		}
		const result = await world.finish()
		expect(result.states.server).toEqual([
			{ id: "item-1", text: "Optimistic ghost", done: false, priority: 5 },
		])
		expect(result.states.client1).toEqual(result.states.server)
		expect(result.states.client2).toEqual(result.states.server)
	})

	it.each([
		{ seed: 10, steps: 300, faultRate: 0.1 },
		{ seed: 7, steps: 300, faultRate: 0.1, crashRate: 0.02 },
	])("converges after lost removals and restarts: %j", async (options) => {
		const result = await new DstSimulation(options).execute()
		expect(result.violation).toBeUndefined()
		expect(result.states.client1).toEqual(result.states.server)
		expect(result.states.client2).toEqual(result.states.server)
	})
})

/** Advances the oldest pending step that is not held until `done` holds. */
async function advanceUntil(
	world: DstWorld,
	done: () => boolean,
	held: (call: string) => boolean = () => false,
) {
	let step = 1000
	while (!done()) {
		const next = world.pending().find(({ name }) => !held(name))
		if (!next) throw new Error("nothing left to advance")
		await world.apply(step++, { type: "advance", call: next.name })
		await world.settle()
		if (step > 3000) throw new Error("condition never held")
	}
}

const tabTodo = (id: string) => ({
	id,
	text: `Tab ${id}`,
	done: false,
	priority: 1,
})

describe("Deterministic simulation with shared tabs", () => {
	it("keeps tab commits honest through lost messages, failed saves, and crashes", async () => {
		const coverage = {
			takeoversWithPendingCommits: 0,
			acceptedPushRepliesLost: 0,
			failedSaves: 0,
			serverCompletions: 0,
		}
		for (let seed = 1; seed <= 20; seed++) {
			const result = await new DstSimulation({
				seed,
				steps: 300,
				faultRate: 0.1,
				crashRate: 0.02,
				tabs: 3,
			}).execute()
			expect(result.violation, `seed ${seed}`).toBeUndefined()
			for (const key of Object.keys(coverage) as (keyof typeof coverage)[])
				coverage[key] += result.tabCoverage![key]
		}

		// Passing seeds only count if they reached the situations under test.
		expect(coverage.takeoversWithPendingCommits).toBeGreaterThan(0)
		expect(coverage.acceptedPushRepliesLost).toBeGreaterThan(0)
		expect(coverage.failedSaves).toBeGreaterThan(0)
		expect(coverage.serverCompletions).toBeGreaterThan(0)
	})

	it("replays a run with tabs to the same outcome", async () => {
		const sink = memorySink()
		const run = await new DstSimulation({
			seed: 4,
			steps: 300,
			faultRate: 0.1,
			crashRate: 0.02,
			tabs: 3,
		}).execute(sink)

		const replayed = await replay(parseArtifact(formatArtifact(sink.lines)))

		expect(run.trace.some(({ type }) => type === "openTab")).toBe(true)
		expect(replayed).toEqual({
			stepsCompleted: run.stepsCompleted,
			violation: run.violation,
			divergence: undefined,
		})
	})

	it("completes a tab commit once after the server accepts it and the reply is lost in a takeover", async () => {
		await using world = await DstWorld.start(1, { tabs: 2 })
		const tabs = world.tabs!
		await world.apply(0, {
			type: "set",
			client: "tab2",
			item: tabTodo("lost-reply"),
		})
		await world.settle()

		// The leader's push reaches the server, but its reply is lost, then the leader crashes.
		const push = (waitingFor: string) =>
			world
				.pending()
				.find(
					({ name, waitingFor: next }) =>
						name.startsWith("tabsRemote.push") && next === waitingFor,
				)
		await advanceUntil(world, () => push("server") !== undefined)
		await world.apply(1, { type: "advance", call: push("server")!.name })
		await world.settle()
		await advanceUntil(world, () => push("tabsRemote") !== undefined)
		await world.apply(2, { type: "drop", call: push("tabsRemote")!.name })
		await world.apply(3, { type: "crash", client: "tab1" })
		await world.settle()

		const outcome = await world.finish()
		expect(outcome.violation).toBeUndefined()
		expect(outcome.tabCoverage?.acceptedPushRepliesLost).toBe(1)
		expect(tabs.commitOf("Tab lost-reply")).toBe("completed")
		expect(outcome.states.server).toEqual([tabTodo("lost-reply")])
	})

	it("completes a tab commit through the next leader when the leader crashes after saving it", async () => {
		await using world = await DstWorld.start(1, { tabs: 2 })
		const tabs = world.tabs!
		await world.apply(0, {
			type: "set",
			client: "tab2",
			item: tabTodo("saved"),
		})
		await world.settle()

		// The forwarded write is durable, but the leader dies before tab2 hears back.
		await advanceUntil(world, () => tabs.saved("saved"))
		await world.apply(1, { type: "crash", client: "tab1" })
		await world.settle()
		expect(tabs.commitOf("Tab saved")).toBe("pending")

		const outcome = await world.finish()
		expect(outcome.violation).toBeUndefined()
		expect(tabs.commitOf("Tab saved")).toBe("completed")
		expect(outcome.states.server).toEqual([tabTodo("saved")])
	})

	it("resends a write whose leader save failed, ahead of newer writes, to the next leader", async () => {
		await using world = await DstWorld.start(1, { tabs: 2 })
		const tabs = world.tabs!
		await world.apply(0, {
			type: "set",
			client: "tab2",
			item: tabTodo("unsaved"),
		})
		await world.apply(1, {
			type: "set",
			client: "tab2",
			item: tabTodo("newer"),
		})
		await world.settle()

		// The leader fails to save the first write, and tab2 hears about it while the
		// newer write is still pending.
		const failable = () =>
			world
				.pending()
				.find(
					({ name, droppable }) => droppable && name.startsWith("tab1.save"),
				)
		await advanceUntil(world, () => failable() !== undefined)
		await world.apply(2, { type: "drop", call: failable()!.name })
		await world.settle()
		const saving = (call: string) => call.startsWith("tab1.save")
		await advanceUntil(
			world,
			() => tabs.commitOf("Tab unsaved") === "rejected",
			saving,
		)
		expect(tabs.saved("unsaved")).toBe(false)
		expect(tabs.commitOf("Tab newer")).toBe("pending")

		// The leader crashes holding the first write only in memory. The next leader
		// has no marker for tab2, so it accepts whichever write arrives first.
		await world.apply(3, { type: "crash", client: "tab1" })
		await world.settle()

		const outcome = await world.finish()
		expect(outcome.violation).toBeUndefined()
		expect(outcome.states.server).toEqual([
			tabTodo("newer"),
			tabTodo("unsaved"),
		])
		expect(tabs.commitOf("Tab newer")).toBe("completed")
	})

	it("holds a saved tab commit until a replacement leader's delayed connection delivers it", async () => {
		await using world = await DstWorld.start(1, { tabs: 2 })
		const tabs = world.tabs!
		await world.apply(0, { type: "crash", client: "tab1" })
		await world.settle()
		const connecting = (call: string) => call.startsWith("tabsRemote.connect")
		await advanceUntil(world, () => tabs.writers.includes("tab2"), connecting)
		await world.apply(1, {
			type: "set",
			client: "tab2",
			item: tabTodo("waiting"),
		})
		await world.settle()

		// Everything but the connection runs, so the write is saved but not complete.
		await advanceUntil(
			world,
			() => world.pending().every(({ name }) => connecting(name)),
			connecting,
		)
		expect(tabs.saved("waiting")).toBe(true)
		expect(tabs.commitOf("Tab waiting")).toBe("pending")

		const outcome = await world.finish()
		expect(outcome.violation).toBeUndefined()
		expect(tabs.commitOf("Tab waiting")).toBe("completed")
	})
})
