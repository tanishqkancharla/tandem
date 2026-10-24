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
	it("converges to the server with interleaved calls and no faults", async () => {
		const result = await new DstSimulation({ seed: 3, steps: 300 }).execute()

		expect(result.violation).toBeUndefined()
		expect(result.states.client1).toEqual(result.states.server)
		expect(result.states.client2).toEqual(result.states.server)
	})

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

	it("counts concurrent offline bumps from both clients, which replaying recorded updates would not", async () => {
		await using world = await DstWorld.start(2)
		await world.apply(0, {
			type: "set",
			client: "client1",
			item: { id: "shared", text: "Shared", done: false, priority: 3 },
		})
		// Both clients receive the todo and disconnect before bumping it.
		await world.finish()
		await world.apply(1, { type: "bump", client: "client1", id: "shared" })
		await world.apply(2, { type: "bump", client: "client2", id: "shared" })

		const result = await world.finish()
		// Each client's recorded update says priority 4; the server ran both bumps.
		expect(result.states.server).toEqual([
			{ id: "shared", text: "Shared", done: false, priority: 5 },
		])
		expect(world.effectCount).toBe(2)
		expect(result.violation).toBeUndefined()
	})

	it("rolls back a bump the server refuses without blocking the client's later writes", async () => {
		await using world = await DstWorld.start(2)
		const done = { id: "item-1", text: "Done", done: true, priority: 3 }
		await world.apply(0, { type: "set", client: "client1", item: done })
		await world.finish()
		// The client bumps a done todo; only the server knows that rule.
		await world.apply(1, { type: "bump", client: "client1", id: "item-1" })
		const later = { id: "item-2", text: "Later", done: false, priority: 1 }
		await world.apply(2, { type: "set", client: "client1", item: later })

		const result = await world.finish()
		expect(result.states.server).toEqual([done, later])
		expect(world.effectCount).toBe(0)
		expect(result.violation).toBeUndefined()
	})

	it("pushes a bump left pending by a crash once the client restarts from storage", async () => {
		await using world = await DstWorld.start(2)
		const item = { id: "item-1", text: "Pending", done: false, priority: 3 }
		await world.apply(0, { type: "set", client: "client1", item })
		await world.finish()
		// Offline, the bump reaches storage but not the server.
		await world.apply(1, { type: "bump", client: "client1", id: "item-1" })
		await world.drain()
		await world.apply(2, { type: "crash", client: "client1" })

		const result = await world.finish()
		expect(result.states.server).toEqual([{ ...item, priority: 4 }])
		expect(world.effectCount).toBe(1)
		expect(result.violation).toBeUndefined()
	})

	it("runs a bump's effect once when the push response carrying it is lost", async () => {
		await using world = await DstWorld.start(2)
		const item = { id: "item-1", text: "Lost reply", done: false, priority: 3 }
		await world.apply(0, { type: "set", client: "client1", item })
		// Deliver the set, so the bump's push is the one whose reply is lost.
		let step = 1
		await world.settle()
		while (world.pending().some(({ name }) => name === "client1.commit#1")) {
			await world.apply(step++, { type: "advance", call: "client1.commit#1" })
			await world.settle()
		}
		await world.apply(step++, { type: "bump", client: "client1", id: "item-1" })
		await world.settle()
		// Advance the bump until the server's reply to its push, then lose it.
		for (;;) {
			const call = world
				.pending()
				.find(({ name }) => name === "client1.bumpPriority#1")
			if (!call) throw new Error("The bump finished before its push")
			if (call.sentBy === "server") break
			await world.apply(step++, { type: "advance", call: call.name })
			await world.settle()
		}
		const dropped = await world.apply(step, {
			type: "drop",
			call: "client1.bumpPriority#1",
		})
		expect(dropped).toMatchObject({ fault: "responseLost" })

		// Settlement resends the mutation; the server skips it.
		const result = await world.finish()
		expect(result.states.server).toEqual([{ ...item, priority: 4 }])
		expect(world.effectCount).toBe(1)
		expect(result.violation).toBeUndefined()
	})

	it.each([
		{ seed: 5, steps: 300, faultRate: 0.1 },
		{ seed: 11, steps: 300, faultRate: 0.1, crashRate: 0.02 },
	])(
		"runs each applied bump's after effect once under lost responses: %j",
		async (options) => {
			const result = await new DstSimulation(options).execute()

			expect(
				result.trace.filter(({ type }) => type === "bump").length,
			).toBeGreaterThan(5)
			expect(
				result.trace.some(
					(record) => record.type === "drop" && record.fault === "responseLost",
				),
			).toBe(true)
			expect(result.violation).toBeUndefined()
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
