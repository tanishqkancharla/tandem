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

type CheckpointEvent = Extract<DstTraceRecord, { outcome: unknown }>

/** Deliver held calls fairly without disabling gates or forcing client pulls. */
async function advanceHeld(world: DstWorld, startStep: number) {
	const events: DstTraceRecord[] = []
	const serviced = new Map<string, number>()
	for (let count = 0; count < 1000; count++) {
		await world.settle()
		const next = [...world.pending()].sort(
			(a, b) => (serviced.get(a.name) ?? -1) - (serviced.get(b.name) ?? -1),
		)[0]
		if (world.serverTicksPending > 0) {
			events.push(
				await world.apply(startStep + events.length, { type: "serverTick" }),
			)
			continue
		}
		if (!next) return events
		serviced.set(next.name, count)
		events.push(
			await world.apply(startStep + events.length, {
				type: "advance",
				call: next.name,
			}),
		)
	}
	throw new Error("Held calls did not settle within the test's delivery budget")
}

describe("DST ordinary recovery", () => {
	it("propagates continuously connected writes before forced repair", async () => {
		await using world = await DstWorld.start({ seed: 61 })
		await world.apply(0, {
			type: "mutate",
			client: "client1",
			ops: [
				{
					type: "set",
					collection: "projects",
					value: { id: "connected", name: "Ordinary propagation" },
				},
			],
		})
		const events: DstTraceRecord[] = []
		const result = await recover(world, {
			startStep: 1,
			eventBudget: 1000,
			record: (event) => events.push(event),
		})

		const checkpoint = events.find(
			(event): event is CheckpointEvent => event.type === "checkpoint",
		)
		expect(checkpoint?.outcome.violation).toBeUndefined()
		expect(checkpoint?.outcome.states.client2.projects).toEqual([
			{ id: "connected", name: "Ordinary propagation" },
		])
		expect(
			events
				.slice(0, -2)
				.every(
					(event) => event.type === "advance" || event.type === "serverTick",
				),
		).toBe(true)
		expect(events.at(-1)?.type).toBe("repair")
		expect(result.recovery).toMatchObject({
			ordinary: "passed",
			repaired: "passed",
		})
		expect(result.recovery.eventsDelivered).toBeGreaterThan(0)
	})

	it("reconnects an offline writer after a long durable burst and catches up both peers", async () => {
		await using world = await DstWorld.start({ seed: 62 })
		let step = 0
		await world.apply(step++, { type: "disconnect", client: "client2" })
		step += (await advanceHeld(world, step)).length
		const offlineProjects = Array.from({ length: 12 }, (_, index) => ({
			id: `offline-${index.toString().padStart(2, "0")}`,
			name: `Offline edit ${index}`,
		}))
		for (const value of offlineProjects) {
			await world.apply(step++, {
				type: "mutate",
				client: "client2",
				ops: [{ type: "set", collection: "projects", value }],
			})
		}
		await world.apply(step++, {
			type: "mutate",
			client: "client1",
			ops: [
				{
					type: "set",
					collection: "projects",
					value: { id: "remote", name: "Written while peer is offline" },
				},
			],
		})
		step += (await advanceHeld(world, step)).length
		expect(world.inventoryOf("client2").projects).toEqual(offlineProjects)
		expect(world.inventoryOf("client1").projects).toHaveLength(1)
		expect(world.offline).toEqual(["client2"])

		const events: DstTraceRecord[] = []
		const result = await recover(world, {
			startStep: step,
			eventBudget: 1000,
			record: (event) => events.push(event),
		})
		expect(events[0]).toMatchObject({ type: "reconnect", client: "client2" })
		expect(result.recovery).toMatchObject({
			ordinary: "passed",
			repaired: "passed",
		})
		const checkpoint = events.find(
			(event): event is CheckpointEvent => event.type === "checkpoint",
		)
		expect(checkpoint?.outcome.states.server.projects).toHaveLength(13)
		expect(checkpoint?.outcome.states.client1).toEqual(
			checkpoint?.outcome.states.server,
		)
		expect(checkpoint?.outcome.states.client2).toEqual(
			checkpoint?.outcome.states.server,
		)
	})

	it.each(["requests", "replies", "both"] as const)(
		"sustains a %s partition while local durable commits still advance",
		async (direction) => {
			await using world = await DstWorld.start({ seed: 63 })
			let step = (await advanceHeld(world, 0)).length
			await world.apply(step++, {
				type: "partition",
				client: "client1",
				direction,
			})
			const projects = [
				{ id: "first", name: "First durable edit" },
				{ id: "second", name: "Second durable edit" },
			]
			const delivered: DstTraceRecord[] = []
			for (const value of projects) {
				await world.apply(step++, {
					type: "mutate",
					client: "client1",
					ops: [{ type: "set", collection: "projects", value }],
				})
				const events = await advanceHeld(world, step)
				step += events.length
				delivered.push(...events)
			}

			expect(world.partitioned).toEqual(["client1"])
			expect(world.mutationsInFlight).toBe(0)
			expect(world.inventoryOf("client1").projects).toEqual(projects)
			const drops = delivered.filter((event) => event.type === "drop")
			expect(drops.length).toBeGreaterThanOrEqual(2)
			if (direction === "replies") {
				expect(drops.every((event) => event.sentBy === "server")).toBe(true)
				expect(drops.some((event) => event.fault === "responseLost")).toBe(true)
			} else {
				expect(
					drops.every(
						(event) =>
							event.waitingFor === "server" && event.fault === "requestLost",
					),
				).toBe(true)
			}
			expect(
				delivered.some(
					(event) =>
						event.type === "advance" && event.waitingFor === "client1Storage",
				),
			).toBe(true)
			expect(delivered).toContainEqual(
				expect.objectContaining({
					type: "advance",
					sentBy: "client1Timer",
					waitingFor: "client1",
				}),
			)
			const checkpoint = await world.apply(step++, { type: "checkpoint" })
			expect(
				checkpoint.type === "checkpoint" &&
					checkpoint.outcome.states.server.projects,
			).toEqual(direction === "replies" ? projects : [])

			// A new incarnation must load the commits from durable storage, not RAM.
			await world.apply(step++, { type: "crash", client: "client1" })
			const recovery: DstTraceRecord[] = []
			const result = await recover(world, {
				startStep: step,
				eventBudget: 1000,
				record: (event) => recovery.push(event),
			})
			expect(recovery.slice(0, 2).map((event) => event.type)).toEqual([
				"heal",
				"restart",
			])
			expect(result.recovery).toMatchObject({
				ordinary: "passed",
				repaired: "passed",
			})
			const ordinary = recovery.find(
				(event): event is CheckpointEvent => event.type === "checkpoint",
			)
			expect(ordinary?.outcome.states.client1.projects).toEqual(projects)
			expect(ordinary?.outcome.states.client2.projects).toEqual(projects)
		},
	)

	it("heals a lost-poke partition without hiding the ordinary mismatch behind a pull", async () => {
		await using world = await DstWorld.start({ seed: 64 })
		let step = (await advanceHeld(world, 0)).length
		await world.apply(step++, {
			type: "partition",
			client: "client2",
			direction: "replies",
		})
		const project = {
			id: "lost-poke",
			name: "Only the server and writer saw this",
		}
		await world.apply(step++, {
			type: "mutate",
			client: "client1",
			ops: [{ type: "set", collection: "projects", value: project }],
		})
		const partitionEvents = await advanceHeld(world, step)
		step += partitionEvents.length
		expect(partitionEvents).toContainEqual(
			expect.objectContaining({
				type: "drop",
				fault: "pokeLost",
				waitingFor: "client2",
			}),
		)
		expect(world.inventoryOf("client1").projects).toEqual([project])
		expect(world.inventoryOf("client2").projects).toEqual([])

		await world.apply(step++, { type: "heal", client: "client2" })
		const afterHeal = await advanceHeld(world, step)
		step += afterHeal.length
		expect(afterHeal).toEqual([])
		expect(world.offline).toEqual([])
		expect(world.inventoryOf("client2").projects).toEqual([])

		const events: DstTraceRecord[] = []
		const result = await recover(world, {
			startStep: step,
			eventBudget: 1000,
			record: (event) => events.push(event),
		})
		expect(events.map((event) => event.type)).toEqual(["checkpoint", "repair"])
		expect(result.recovery).toEqual({
			ordinary: "viewMismatch",
			repaired: "passed",
			eventsDelivered: 0,
		})
		const checkpoint = events.find(
			(event): event is CheckpointEvent => event.type === "checkpoint",
		)
		expect(checkpoint?.outcome.violation).toMatchObject({
			checkpoint: "ordinary",
			client: "client2",
			actual: [],
			expected: [project],
		})
		expect(result.violation).toEqual(checkpoint?.outcome.violation)
		expect(
			events.find((event): event is CheckpointEvent => event.type === "repair")
				?.outcome.violation,
		).toBeUndefined()
		expect(result.states.client2.projects).toEqual([project])
	})

	it("explicitly reconnects a failed connection after restoring transport", async () => {
		await using world = await DstWorld.start({ seed: 66 })
		let step = 0
		await world.apply(step++, { type: "disconnect", client: "client2" })
		step += (await advanceHeld(world, step)).length
		await world.apply(step++, {
			type: "partition",
			client: "client2",
			direction: "requests",
		})
		await world.apply(step++, { type: "reconnect", client: "client2" })
		const failed = await advanceHeld(world, step)
		step += failed.length
		expect(failed).toContainEqual(
			expect.objectContaining({ type: "drop", fault: "requestLost" }),
		)
		expect(world.offline).toEqual(["client2"])

		const events: DstTraceRecord[] = []
		const result = await recover(world, {
			startStep: step,
			eventBudget: 1000,
			record: (event) => events.push(event),
		})
		expect(events.slice(0, 2)).toEqual([
			{ type: "heal", client: "client2", step },
			{ type: "reconnect", client: "client2", step: step + 1 },
		])
		expect(result.recovery).toMatchObject({
			ordinary: "passed",
			repaired: "passed",
		})
	})

	it("exhausts a zero-event budget reconnecting an empty client with no active commits", async () => {
		await using world = await DstWorld.start({ seed: 68, clientCount: 1 })
		let step = (await advanceHeld(world, 0)).length
		await world.apply(step++, { type: "disconnect", client: "client1" })
		step += (await advanceHeld(world, step)).length
		expect(world.mutationsInFlight).toBe(0)
		expect(world.pending()).toEqual([])
		expect(world.inventoryOf("client1").projects).toEqual([])

		const events: DstTraceRecord[] = []
		const result = await recover(world, {
			startStep: step,
			eventBudget: 0,
			record: (event) => events.push(event),
		})
		expect(events.map((event) => event.type)).toEqual([
			"reconnect",
			"checkpoint",
			"repair",
		])
		const checkpoint = events.find(
			(event): event is CheckpointEvent => event.type === "checkpoint",
		)
		expect(checkpoint?.outcome.settled).toBe(false)
		expect(checkpoint?.outcome.violation).toBeUndefined()
		expect(result.recovery).toEqual({
			ordinary: "budgetExceeded",
			repaired: "passed",
			eventsDelivered: 0,
		})
	})

	it("does not count a held subscription pull as settled just because no commit is active", async () => {
		await using world = await DstWorld.start({
			seed: 69,
			clientCount: 1,
			initialSubscriptions: "none",
		})
		let step = (await advanceHeld(world, 0)).length
		await world.apply(step++, {
			type: "subscribe",
			client: "client1",
			id: "projects",
			spec: { kind: "inventory", collection: "projects" },
		})
		await world.settle()
		// Release the subscription's debounce tick, but leave its pull held.
		const tick = world.pending()[0]
		if (!tick) throw new Error("The subscription did not schedule a pull")
		await world.apply(step++, { type: "advance", call: tick.name })
		await world.settle()
		expect(
			world.pending().map(({ sentBy, waitingFor }) => ({ sentBy, waitingFor })),
		).toContainEqual(
			expect.objectContaining({ sentBy: "client1", waitingFor: "server" }),
		)
		expect(world.mutationsInFlight).toBe(0)
		expect(world.offline).toEqual([])

		const events: DstTraceRecord[] = []
		const result = await recover(world, {
			startStep: step,
			eventBudget: 0,
			record: (event) => events.push(event),
		})
		const checkpoint = events.find(
			(event): event is CheckpointEvent => event.type === "checkpoint",
		)
		expect(checkpoint?.outcome.settled).toBe(false)
		expect(checkpoint?.outcome.violation).toBeUndefined()
		expect(result.recovery).toEqual({
			ordinary: "budgetExceeded",
			repaired: "passed",
			eventsDelivered: 0,
		})
	})

	it.each([0, 6])(
		"reports only %i recorded workload steps from an incomplete 1000-step artifact",
		async (recordedSteps) => {
			const options = resolveRunOptions({ seed: 70, steps: 1000 })
			const sink = memorySink()
			sink.write({ kind: "header", format: 1, options })
			await using world = await DstWorld.start(options)
			for (let step = 0; step < recordedSteps; step++) {
				world.pending()
				const event = await world.apply(step, {
					type: "mutate",
					client: "client1",
					ops: [
						{
							type: "set",
							collection: "projects",
							value: { id: `project-${step}`, name: `Project ${step}` },
						},
					],
				})
				sink.write({ kind: "event", ...event })
				await world.settle()
			}
			await world.drain()
			const artifact = parseArtifact(formatArtifact(sink.lines))
			expect(artifact.outcome).toBeUndefined()
			expect(await replay(artifact)).toEqual({
				stepsCompleted: recordedSteps,
				violation: undefined,
				divergence: undefined,
			})
		},
	)

	it("rejects a changed final inventory even when the recorded violation is unchanged", async () => {
		const sink = memorySink()
		await new DstSimulation({
			seed: 71,
			steps: 1,
			connectivityRate: 0,
			subscriptionRate: 0,
		}).execute(sink)
		const artifact = parseArtifact(formatArtifact(sink.lines))
		if (!artifact.outcome)
			throw new Error("The simulation did not record an outcome")
		expect(artifact.outcome.violation).toBeUndefined()
		artifact.outcome.states.server.projects.push({
			id: "not-recorded",
			name: "Changed final inventory",
		})

		const result = await replay(artifact)
		expect(result.stepsCompleted).toBe(1)
		expect(result.violation).toBeUndefined()
		expect(result.divergence).toEqual({
			step: artifact.trace.at(-1)?.step,
			expected: artifact.trace.at(-1),
			reason: "the final outcome differs from the recording",
		})
	})

	it("replays recorded fair recovery advances and their checkpoint outcomes", async () => {
		const sink = memorySink()
		const result = await new DstSimulation({
			seed: 67,
			steps: 30,
			connectivityRate: 0,
			subscriptionRate: 0,
			recoveryEvents: 1000,
		}).execute(sink)
		expect(result.recovery.ordinary).toBe("passed")
		expect(result.recovery.eventsDelivered).toBeGreaterThan(0)
		expect(result.recovery.eventsDelivered).toBe(
			result.trace.filter(
				(event) =>
					event.step >= 30 &&
					(event.type === "advance" || event.type === "serverTick"),
			).length,
		)
		const artifact = parseArtifact(formatArtifact(sink.lines))
		expect(await replay(artifact)).toEqual({
			stepsCompleted: 30,
			violation: undefined,
			divergence: undefined,
			recovery: result.recovery,
		})
	})

	it.each([0, 1])(
		"records exhaustion of a %i-event budget separately from repair and replays it exactly",
		async (eventBudget) => {
			const sink = memorySink()
			const result = await new DstSimulation({
				seed: 1,
				steps: 1,
				clientCount: 2,
				connectivityRate: 0,
				subscriptionRate: 0,
				recoveryEvents: eventBudget,
			}).execute(sink)

			expect(result.recovery).toEqual({
				ordinary: "budgetExceeded",
				repaired: "passed",
				eventsDelivered: eventBudget,
			})
			expect(result.trace.slice(-2).map((event) => event.type)).toEqual([
				"checkpoint",
				"repair",
			])
			const artifact = parseArtifact(formatArtifact(sink.lines))
			expect(artifact.outcome?.recovery).toEqual(result.recovery)
			expect(await replay(artifact)).toEqual({
				stepsCompleted: 1,
				violation: result.violation,
				divergence: undefined,
				recovery: {
					ordinary: "budgetExceeded",
					repaired: "passed",
					eventsDelivered: eventBudget,
				},
			})
		},
	)
})
