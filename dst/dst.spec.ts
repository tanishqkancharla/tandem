import { spawnSync } from "node:child_process"
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { matchBy } from "@tanishqkancharla/tandem-core"
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
	it.each([1, 2, 3, 5, 10])(
		"converges with %i clients and interleaved calls",
		async (clientCount) => {
			const sink = memorySink()
			const result = await new DstSimulation({
				seed: 3,
				steps: 1000,
				clientCount,
			}).execute(sink)
			const names = Array.from(
				{ length: clientCount },
				(_, i): `client${number}` => `client${i + 1}`,
			)

			expect(result.violation).toBeUndefined()
			expect(result.states.server.length).toBeGreaterThan(0)
			expect(Object.keys(result.states)).toEqual(["server", ...names])
			expect(new Set(result.clientIds).size).toBe(clientCount)
			for (const name of names)
				expect(result.states[name]).toEqual(result.states.server)
			expect(
				new Set(
					result.trace.flatMap((event) =>
						event.type === "set" ||
						event.type === "update" ||
						event.type === "remove"
							? [event.client]
							: [],
					),
				),
			).toEqual(new Set(names))
			expect(sink.lines[0]).toEqual({
				kind: "header",
				format: 1,
				options: {
					seed: 3,
					steps: 1000,
					clientCount,
					recordCount: 3,
					maxMutationsInFlight: 4,
					sharedWriteRate: 1,
					faultRate: 0,
					crashRate: 0,
				},
			})
		},
	)

	it.each(["client1", "client2"] as const)(
		"preserves disjoint offline field updates when %s edits completion",
		async (completionClient) => {
			await using world = await DstWorld.start({ seed: 2 })
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
		await using world = await DstWorld.start({ seed: 2 })
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

	it.each([1, 6])(
		"bounds outstanding mutations at %i independently of other calls",
		async (limit) => {
			const result = await new DstSimulation({
				seed: 3,
				steps: 300,
				clientCount: 5,
				maxMutationsInFlight: limit,
			}).execute()

			expect(result.violation).toBeUndefined()
			expect(result.maxMutationsInFlight).toBe(limit)
			expect(result.maxPendingCalls).toBeGreaterThan(limit)
		},
	)

	it("holds concurrent writes from distinct clients through their result", async () => {
		await using world = await DstWorld.start({ seed: 3, clientCount: 3 })
		const items = world.clientNames.map((client, index) => ({
			id: client,
			text: `From ${client}`,
			done: false,
			priority: index + 1,
		}))
		for (const [index, client] of world.clientNames.entries()) {
			await world.apply(index, { type: "set", client, item: items[index] })
		}
		await world.settle()
		const calls = world.pending()
		expect(new Set(calls.map(({ label }) => label))).toEqual(
			new Set(["client1.commit", "client2.commit", "client3.commit"]),
		)
		const first = calls[0]
		await world.apply(3, { type: "advance", call: first.name })
		await world.settle()
		expect(world.mutationsInFlight).toBe(3)

		const result = await world.finish()
		expect(world.mutationsInFlight).toBe(0)
		expect(result.violation).toBeUndefined()
		expect(result.states.server).toEqual(items)
	})

	it.each([
		{ sharedWriteRate: 0, recordCount: 1 },
		{ sharedWriteRate: 1, recordCount: 7 },
	])(
		"targets configured record pools: %j",
		async ({ sharedWriteRate, recordCount }) => {
			const result = await new DstSimulation({
				seed: 3,
				steps: 300,
				clientCount: 3,
				recordCount,
				sharedWriteRate,
			}).execute()
			const ids = result.trace.flatMap((event) => {
				if (
					event.type !== "set" &&
					event.type !== "update" &&
					event.type !== "remove"
				)
					return []
				const id = matchBy(event, "type", {
					set: ({ item }) => item.id,
					update: ({ id }) => id,
					remove: ({ id }) => id,
				})
				const prefix = sharedWriteRate === 1 ? "item-" : `${event.client}-item-`
				expect(id.startsWith(prefix)).toBe(true)
				return [Number(id.slice(prefix.length))]
			})

			expect(result.violation).toBeUndefined()
			expect(ids).toContain(recordCount)
			expect(ids.every((id) => id >= 1 && id <= recordCount)).toBe(true)
		},
	)

	it("reproduces a run exactly from its seed, including every generated id", async () => {
		const options = {
			seed: 42,
			steps: 300,
			faultRate: 0.1,
			clientCount: 5,
			recordCount: 7,
			maxMutationsInFlight: 6,
			sharedWriteRate: 0.4,
		}

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
			clientCount: 5,
			recordCount: 9,
			maxMutationsInFlight: 3,
			sharedWriteRate: 0.4,
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
		const sink = memorySink()
		await new DstSimulation({ seed: 2, steps: 12 }).execute(sink)
		const artifact = parseArtifact(formatArtifact(sink.lines))
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

	it("reproduces the known removal inconsistency after crashes", async () => {
		const artifact = parseArtifact(
			readFileSync(
				new URL("./known-failures/crash-removal.jsonl", import.meta.url),
				"utf8",
			),
		)
		const result = await replay(artifact)

		// Preserve the failing outcome until fixed, then remove this recording.
		expect(result).toEqual({
			stepsCompleted: 1000,
			divergence: undefined,
			violation: artifact.outcome?.violation,
		})
		expect(result.violation).toMatchObject({
			client: "client4",
			step: "quiescence",
		})
		expect(result.violation?.expected.map(({ id }) => id)).not.toContain(
			"client4-item-1",
		)
		expect(result.violation?.actual).toContainEqual({
			id: "client4-item-1",
			text: "Note client4-item-1 (rev 176)",
			done: true,
			priority: 1,
		})
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

	it.each([
		["client-count", "0"],
		["record-count", "-1"],
		["max-mutations-in-flight", "1.5"],
		["steps", "9007199254740992"],
		["runs", "0"],
		["shared-write-rate", "1.1"],
		["fault-rate", "-0.1"],
		["crash-rate", "Infinity"],
	])("rejects --%s=%s at the CLI boundary", (name, value) => {
		const result = spawnSync(
			process.execPath,
			[
				"--import",
				"tsx",
				new URL("./cli.ts", import.meta.url).pathname,
				`--${name}=${value}`,
			],
			{ cwd: new URL(".", import.meta.url), encoding: "utf8" },
		)

		expect(result.status).toBe(2)
		expect(result.stderr).toContain(`--${name} must be`)
	})
})
