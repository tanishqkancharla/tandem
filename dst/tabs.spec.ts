import { describe, expect, it } from "vitest"
import { recover } from "./DstRecovery.js"
import {
	formatArtifact,
	memorySink,
	parseArtifact,
	replay,
} from "./DstReplay.js"
import { DstSimulation, resolveRunOptions } from "./DstSimulation.js"
import { DstWorld, type DstTraceRecord } from "./DstWorld.js"

async function advanceUntil(
	world: DstWorld,
	done: () => boolean,
	held: (call: string) => boolean = () => false,
) {
	let step = 1000
	while (!done()) {
		const next = world.pending().find(({ name }) => !held(name))
		if (!next || step > 3000) throw new Error("tab event did not become ready")
		await world.apply(step++, { type: "advance", call: next.name })
		await world.settle()
	}
}

const task = (id: string) => ({
	id,
	projectId: id,
	text: `Tab ${id}`,
	done: false,
	priority: 1,
})
const write = (id: string) => ({
	type: "mutate" as const,
	client: "tab2" as const,
	ops: [
		{ type: "set" as const, collection: "tasks" as const, value: task(id) },
	],
})

describe("DST shared tabs", () => {
	it("unregisters a connected leader when its browser tab crashes", async () => {
		await using world = await DstWorld.start({ seed: 17, tabs: 2 })
		await world.drain()
		const leader = world.tabs!.leader!
		await world.apply(0, { type: "crash", client: leader })
		await world.settle()
		const pokesAfterCrash = world.tabs!.pokesAfterCrash
		await world.apply(1, { type: "serverSet", item: task("after-crash") })
		const outcome = await recover(world, {
			startStep: 2,
			eventBudget: 300,
			record: () => {},
		})
		expect(outcome.violation).toBeUndefined()
		expect(outcome.recovery.ordinary).toBe("passed")
		expect(world.tabs!.pokesAfterCrash).toBe(pokesAfterCrash)
	})

	it("retries a failed tab connection without unaccepted writes", async () => {
		await using world = await DstWorld.start({ seed: 18, tabs: 2 })
		await world.apply(0, { type: "crash", client: "tab1" })
		await world.settle()
		const connecting = () =>
			world
				.pending()
				.find(
					({ name, waitingFor }) =>
						name.startsWith("tabsRemote.connect") && waitingFor === "server",
				)
		await advanceUntil(world, () => connecting() !== undefined)
		await world.apply(1, { type: "drop", call: connecting()!.name })
		await world.settle()
		await advanceUntil(world, () => world.tabs!.failedConnectionTabs.length > 0)
		expect(world.tabs!.unacceptedTabs).toEqual([])
		await world.apply(2, { type: "serverSet", item: task("after-failure") })
		const events: DstTraceRecord[] = []
		const outcome = await recover(world, {
			startStep: 3,
			eventBudget: 300,
			record: (event) => events.push(event),
		})
		expect(events).toContainEqual(
			expect.objectContaining({ type: "connectTab", tab: "tab2" }),
		)
		expect(outcome.recovery.ordinary).toBe("passed")
		expect(outcome.violation).toBeUndefined()
		expect(outcome.states.tabs?.tab2.tasks).toContainEqual(
			task("after-failure"),
		)
	})

	it("reopens shared storage when every tab crashed before ordinary recovery", async () => {
		await using world = await DstWorld.start({ seed: 9, tabs: 2 })
		const trace: DstTraceRecord[] = [
			await world.apply(0, { type: "crash", client: "tab1" }),
		]
		await world.settle()
		trace.push(await world.apply(1, { type: "crash", client: "tab2" }))
		await world.settle()
		const events: string[] = []
		const outcome = await recover(world, {
			startStep: 2,
			eventBudget: 300,
			record: (event) => {
				trace.push(event)
				if (event.type === "openTab") events.push(event.tab)
			},
		})
		expect(events).toEqual(["tab3"])
		expect(outcome.recovery.ordinary).toBe("passed")
		expect(outcome.violation).toBeUndefined()
		const replayed = await replay({
			options: resolveRunOptions({ seed: 9, steps: 2, tabs: 2 }),
			trace: JSON.parse(JSON.stringify(trace)) as DstTraceRecord[],
		})
		expect(replayed.divergence).toBeUndefined()
		expect(replayed.recovery?.ordinary).toBe("passed")
	})

	it("does not mistake a tab's offline completion for early server completion", async () => {
		const result = await new DstSimulation({
			seed: 1,
			steps: 300,
			tabs: 3,
			crashRate: 0.02,
			initialSubscriptions: "full",
		}).execute()
		expect(result.trace).toContainEqual(
			expect.objectContaining({
				type: "toggleTab",
				tab: "tab1",
				wantsServer: false,
			}),
		)
		expect(result.violation).toBeUndefined()
		expect(result.recovery.ordinary).toBe("passed")
	})

	it("seeded faults exercise takeover, lost replies, failed saves, and batch operations", async () => {
		const counts = {
			takeoversWithPendingCommits: 0,
			acceptedPushRepliesLost: 0,
			failedSaves: 0,
			serverCompletions: 0,
		}
		const operations = new Set<string>()
		let multiOperationCommits = 0
		for (let seed = 1; seed <= 30; seed++) {
			const result = await new DstSimulation({
				seed,
				steps: 300,
				tabs: 3,
				faultRate: 0.1,
				crashRate: 0.02,
				initialSubscriptions: "full",
			}).execute()
			expect(result.recovery.repaired, `seed ${seed}`).toBe("passed")
			for (const key of Object.keys(counts) as (keyof typeof counts)[])
				counts[key] += result.tabCoverage![key]
			for (const operation of Object.keys(result.tabCoverage!.operations))
				operations.add(operation)
			for (const [size, count] of Object.entries(
				result.tabCoverage!.batchSizes,
			))
				if (Number(size) > 1) multiOperationCommits += count
		}
		for (const count of Object.values(counts)) expect(count).toBeGreaterThan(0)
		for (const collection of ["projects", "tasks", "comments", "memberships"])
			expect(
				[...operations].some((operation) =>
					operation.startsWith(`${collection}.`),
				),
			).toBe(true)
		expect(multiOperationCommits).toBeGreaterThan(0)
	}, 30_000)

	it("reconnects every intentionally offline tab during ordinary recovery", async () => {
		await using world = await DstWorld.start({ seed: 8, tabs: 2 })
		await world.apply(0, { type: "toggleTab", tab: "tab1" })
		await world.apply(1, { type: "toggleTab", tab: "tab2" })
		await world.settle()
		expect(world.tabs!.offline).toEqual(["tab1", "tab2"])
		await world.apply(2, { type: "serverSet", item: task("reply-1") })
		await world.drain()
		const events: string[] = []
		const outcome = await recover(world, {
			startStep: 3,
			eventBudget: 300,
			record: (event) => {
				if (event.type === "toggleTab") events.push(event.tab)
			},
		})
		expect(events).toEqual(["tab1", "tab2"])
		expect(outcome.recovery.ordinary).toBe("passed")
		expect(outcome.violation).toBeUndefined()
		expect(outcome.states.tabs?.tab1.tasks).toContainEqual(task("reply-1"))
	})

	it("counts unfinished tab commits in concurrency and recovery settlement", async () => {
		await using world = await DstWorld.start({ seed: 1, tabs: 2 })
		await world.apply(0, write("first"))
		await world.apply(1, write("second"))
		expect(world.mutationsInFlight).toBe(2)
		expect(world.maxMutationsInFlight).toBeGreaterThanOrEqual(2)
		expect((await world.checkpoint("ordinary")).settled).toBe(false)
		const outcome = await world.finish()
		expect(outcome.violation).toBeUndefined()
		expect(world.mutationsInFlight).toBe(0)
		expect(outcome.tabCoverage?.successfulCommits).toBe(2)
		expect(outcome.tabCoverage?.operations["tasks.set"]).toBe(2)
		expect(outcome.tabCoverage?.batchSizes["1"]).toBe(2)
	})

	it("forwards a tab batch across collections and compound identities", async () => {
		await using world = await DstWorld.start({ seed: 2, tabs: 2 })
		await world.apply(0, {
			type: "mutate",
			client: "tab2",
			ops: [
				{
					type: "set",
					collection: "projects",
					value: { id: "p", name: "Project" },
				},
				{ type: "set", collection: "tasks", value: task("p") },
				{
					type: "update",
					collection: "tasks",
					id: "p",
					payload: { done: true },
				},
				{
					type: "set",
					collection: "memberships",
					value: { id: ["p", "member"], role: "owner" },
				},
			],
		})
		const outcome = await world.finish()
		expect(outcome.violation).toBeUndefined()
		expect(outcome.states.server.projects).toEqual([
			{ id: "p", name: "Project" },
		])
		expect(outcome.states.server.tasks).toEqual([{ ...task("p"), done: true }])
		expect(outcome.states.server.memberships).toEqual([
			{ id: ["p", "member"], role: "owner" },
		])
		expect(outcome.states.tabs?.tab2).toEqual(outcome.states.server)
		expect(outcome.tabCoverage?.operations).toMatchObject({
			"projects.set": 1,
			"tasks.set": 1,
			"tasks.update": 1,
			"memberships.set": 1,
		})
		expect(outcome.tabCoverage?.batchSizes["4"]).toBe(1)
	})

	it("replays tab events on the expanded schema", async () => {
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
		expect(replayed.divergence).toBeUndefined()
		expect(replayed.violation).toEqual(run.violation)
	})

	it("completes once after an accepted push loses its reply and the leader crashes", async () => {
		await using world = await DstWorld.start({ seed: 1, tabs: 2 })
		await world.apply(0, write("lost-reply"))
		await world.settle()
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
		expect(outcome.tabCoverage?.takeoversWithPendingCommits).toBe(1)
		expect(world.tabs!.commitOf("tab-write-tab2-1")).toBe("completed")
		expect(outcome.states.server.tasks).toContainEqual(task("lost-reply"))
		expect(
			outcome.states.server.comments.filter(
				({ id }) => id === "tab-write-tab2-1",
			),
		).toHaveLength(1)
	})

	it("resends a durable write after takeover without a second server mutation", async () => {
		await using world = await DstWorld.start({ seed: 1, tabs: 2 })
		await world.apply(0, write("saved"))
		await world.settle()
		await advanceUntil(world, () => world.tabs!.saved("tab-write-tab2-1"))
		await world.apply(1, { type: "crash", client: "tab1" })
		await world.settle()
		expect(world.tabs!.commitOf("tab-write-tab2-1")).toBe("pending")
		const outcome = await world.finish()
		expect(outcome.violation).toBeUndefined()
		expect(world.tabs!.commitOf("tab-write-tab2-1")).toBe("completed")
		expect(outcome.states.server.tasks).toContainEqual(task("saved"))
	})

	it("retries a failed save before a newer tab write", async () => {
		await using world = await DstWorld.start({ seed: 1, tabs: 2 })
		await world.apply(0, write("unsaved"))
		await world.apply(1, write("newer"))
		await world.settle()
		const failable = () =>
			world
				.pending()
				.find(
					({ name, droppable }) => droppable && name.startsWith("tab1.save"),
				)
		await advanceUntil(world, () => failable() !== undefined)
		await world.apply(2, { type: "drop", call: failable()!.name })
		await world.settle()
		await advanceUntil(
			world,
			() => world.tabs!.commitOf("tab-write-tab2-1") === "rejected",
			(call) => call.startsWith("tab1.save"),
		)
		expect(world.tabs!.saved("tab-write-tab2-1")).toBe(false)
		await world.apply(3, { type: "crash", client: "tab1" })
		await world.settle()
		const outcome = await world.finish()
		expect(outcome.violation).toBeUndefined()
		expect(outcome.states.server.tasks).toEqual([
			task("newer"),
			task("unsaved"),
		])
		expect(outcome.tabCoverage?.failedSaves).toBe(1)
	})

	it("holds completion until a replacement leader connects", async () => {
		await using world = await DstWorld.start({ seed: 1, tabs: 2 })
		await world.apply(0, { type: "crash", client: "tab1" })
		await world.settle()
		const connecting = (call: string) => call.startsWith("tabsRemote.connect")
		await advanceUntil(
			world,
			() => world.tabs!.writers.includes("tab2"),
			connecting,
		)
		await world.apply(1, write("waiting"))
		await world.settle()
		await advanceUntil(
			world,
			() => world.pending().every(({ name }) => connecting(name)),
			connecting,
		)
		expect(world.tabs!.saved("tab-write-tab2-1")).toBe(true)
		expect(world.tabs!.commitOf("tab-write-tab2-1")).toBe("pending")
		expect((await world.checkpoint("ordinary")).settled).toBe(false)
		const outcome = await world.finish()
		expect(outcome.violation).toBeUndefined()
		expect(world.tabs!.commitOf("tab-write-tab2-1")).toBe("completed")
	})
})
