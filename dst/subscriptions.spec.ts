import { describe, expect, it } from "vitest"
import { DstWorld } from "./DstWorld.js"
import { DstSimulation } from "./DstSimulation.js"

describe("DST subscription workflows", () => {
	it("tracks grouped statistics across remote deletion and group and filter changes", async () => {
		await using world = await DstWorld.start({
			seed: 77,
			clientCount: 2,
			initialSubscriptions: "none",
		})
		await world.apply(0, {
			type: "subscribe",
			client: "client2",
			id: "stats",
			spec: { kind: "taskStats" },
		})
		await world.apply(1, {
			type: "subscribe",
			client: "client1",
			id: "editor",
			spec: { kind: "inventory", collection: "tasks" },
		})
		await world.apply(2, {
			type: "mutate",
			client: "client1",
			ops: [
				{
					type: "set",
					collection: "tasks",
					value: {
						id: "a",
						projectId: "alpha",
						text: "A",
						done: false,
						priority: 2,
					},
				},
				{
					type: "set",
					collection: "tasks",
					value: {
						id: "b",
						projectId: "alpha",
						text: "B",
						done: false,
						priority: 4,
					},
				},
			],
		})
		await world.drain()
		expect(world.subscriptions("client2").get("stats")?.latest).toEqual([
			{ projectId: "alpha", count: 2, averagePriority: 3 },
		])

		await world.apply(3, {
			type: "mutate",
			client: "client1",
			ops: [
				{
					type: "update",
					collection: "tasks",
					id: "a",
					payload: { projectId: "beta" },
				},
			],
		})
		await world.drain()
		expect(world.subscriptions("client2").get("stats")?.latest).toEqual([
			{ projectId: "alpha", count: 1, averagePriority: 4 },
			{ projectId: "beta", count: 1, averagePriority: 2 },
		])

		await world.apply(4, {
			type: "mutate",
			client: "client1",
			ops: [{ type: "remove", collection: "tasks", id: "b" }],
		})
		await world.drain()
		expect(world.subscriptions("client2").get("stats")?.latest).toEqual([
			{ projectId: "beta", count: 1, averagePriority: 2 },
		])

		await world.apply(5, {
			type: "mutate",
			client: "client1",
			ops: [
				{
					type: "update",
					collection: "tasks",
					id: "a",
					payload: { done: true },
				},
			],
		})
		await world.drain()
		expect(world.subscriptions("client2").get("stats")?.latest).toEqual([])
	})

	it("checks aggregate oracles in fault and crash seed sweeps", async () => {
		for (const seed of [2718, 2719, 2720]) {
			const result = await new DstSimulation({
				seed,
				steps: 400,
				faultRate: 0.08,
				crashRate: 0.02,
				subscriptionRate: 0.25,
				aggregateSubscriptionRate: 0.5,
			}).execute()
			expect(result.violation).toBeUndefined()
			expect(
				result.trace.some(
					(event) =>
						event.type === "subscribe" && event.spec.kind === "taskStats",
				),
			).toBe(true)
			expect(
				result.trace.some(
					(event) =>
						event.type === "mutate" &&
						event.ops.some(
							(op) => op.collection === "tasks" && op.type === "remove",
						),
				),
			).toBe(true)
			expect(
				result.trace.some(
					(event) =>
						event.type === "mutate" &&
						event.ops.some(
							(op) => op.collection === "tasks" && op.type === "update",
						),
				),
			).toBe(true)
		}
	})
	it("maintains overlapping and disjoint filtered pages with independent projections", async () => {
		await using world = await DstWorld.start({
			seed: 41,
			clientCount: 2,
			initialSubscriptions: "none",
		})
		await world.apply(0, {
			type: "subscribe",
			client: "client2",
			id: "inbox-page",
			spec: {
				kind: "tasks",
				projectId: "alpha",
				done: false,
				minPriority: 2,
				limit: 1,
				offset: 1,
				projection: true,
			},
		})
		await world.apply(1, {
			type: "subscribe",
			client: "client2",
			id: "urgent",
			spec: {
				kind: "tasks",
				projectId: "alpha",
				done: false,
				minPriority: 5,
				limit: 2,
				offset: 0,
				projection: false,
			},
		})
		await world.apply(2, {
			type: "subscribe",
			client: "client2",
			id: "completed-beta",
			spec: {
				kind: "tasks",
				projectId: "beta",
				done: true,
				minPriority: 0,
				limit: 2,
				offset: 0,
				projection: true,
			},
		})
		// The editing client retains the records it will update in later phases.
		await world.apply(3, {
			type: "subscribe",
			client: "client1",
			id: "editor",
			spec: { kind: "inventory", collection: "tasks" },
		})
		const first = {
			id: "a",
			projectId: "alpha",
			text: "First",
			done: false,
			priority: 9,
		}
		const second = {
			id: "b",
			projectId: "alpha",
			text: "Second",
			done: false,
			priority: 5,
		}
		await world.apply(4, {
			type: "mutate",
			client: "client1",
			ops: [
				{ type: "set", collection: "tasks", value: first },
				{ type: "set", collection: "tasks", value: second },
				{
					type: "set",
					collection: "tasks",
					value: {
						id: "c",
						projectId: "alpha",
						text: "Third",
						done: false,
						priority: 3,
					},
				},
				{
					type: "set",
					collection: "tasks",
					value: {
						id: "low",
						projectId: "alpha",
						text: "Below threshold",
						done: false,
						priority: 1,
					},
				},
				{
					type: "set",
					collection: "tasks",
					value: {
						id: "done",
						projectId: "alpha",
						text: "Wrong status",
						done: true,
						priority: 20,
					},
				},
				{
					type: "set",
					collection: "tasks",
					value: {
						id: "beta",
						projectId: "beta",
						text: "Other project",
						done: true,
						priority: 8,
					},
				},
			],
		})
		await world.drain()

		expect(world.subscriptions("client2").get("inbox-page")?.latest).toEqual([
			{ id: "b", text: "Second" },
		])
		expect(world.subscriptions("client2").get("urgent")?.latest).toEqual([
			first,
			second,
		])
		expect(
			world.subscriptions("client2").get("completed-beta")?.latest,
		).toEqual([{ id: "beta", text: "Other project" }])

		await world.apply(5, {
			type: "mutate",
			client: "client1",
			ops: [
				{
					type: "update",
					collection: "tasks",
					id: "a",
					payload: { done: true },
				},
				{
					type: "update",
					collection: "tasks",
					id: "c",
					payload: { priority: 7, text: "Promoted" },
				},
				{
					type: "update",
					collection: "tasks",
					id: "b",
					payload: { priority: 8 },
				},
				{
					type: "update",
					collection: "tasks",
					id: "beta",
					payload: { text: "Still separate" },
				},
			],
		})
		await world.drain()

		expect(world.subscriptions("client2").get("inbox-page")?.latest).toEqual([
			{ id: "c", text: "Promoted" },
		])
		expect(world.subscriptions("client2").get("urgent")?.latest).toEqual([
			{ id: "b", projectId: "alpha", text: "Second", done: false, priority: 8 },
			{
				id: "c",
				projectId: "alpha",
				text: "Promoted",
				done: false,
				priority: 7,
			},
		])
		expect(
			world.subscriptions("client2").get("completed-beta")?.latest,
		).toEqual([{ id: "beta", text: "Still separate" }])
	})

	it("keeps the remaining overlapping handle live and catches up after the last is removed", async () => {
		await using world = await DstWorld.start({
			seed: 42,
			clientCount: 2,
			initialSubscriptions: "none",
		})
		const spec = {
			kind: "tasks",
			minPriority: 0,
			limit: 2,
			offset: 0,
			projection: true,
		} as const
		await world.apply(0, {
			type: "subscribe",
			client: "client2",
			id: "left",
			spec,
		})
		await world.apply(1, {
			type: "subscribe",
			client: "client2",
			id: "right",
			spec,
		})
		await world.apply(2, {
			type: "subscribe",
			client: "client1",
			id: "editor",
			spec: { kind: "inventory", collection: "tasks" },
		})
		await world.apply(3, {
			type: "mutate",
			client: "client1",
			ops: [
				{
					type: "set",
					collection: "tasks",
					value: {
						id: "shared",
						projectId: "alpha",
						text: "Original",
						done: false,
						priority: 4,
					},
				},
			],
		})
		await world.drain()
		const left = world.subscriptions("client2").get("left")!
		const right = world.subscriptions("client2").get("right")!
		expect(left.latest).toEqual([{ id: "shared", text: "Original" }])
		expect(right.latest).toEqual([{ id: "shared", text: "Original" }])
		await world.apply(4, { type: "unsubscribe", client: "client2", id: "left" })
		const leftSnapshots = structuredClone(left.snapshots)
		await world.apply(5, {
			type: "mutate",
			client: "client1",
			ops: [
				{
					type: "update",
					collection: "tasks",
					id: "shared",
					payload: { text: "One handle" },
				},
			],
		})
		await world.drain()
		expect(world.subscriptions("client2").has("left")).toBe(false)
		expect(right.latest).toEqual([{ id: "shared", text: "One handle" }])
		expect(left.snapshots).toEqual(leftSnapshots)

		await world.apply(6, {
			type: "unsubscribe",
			client: "client2",
			id: "right",
		})
		const rightSnapshots = structuredClone(right.snapshots)
		await world.apply(7, {
			type: "mutate",
			client: "client1",
			ops: [
				{
					type: "update",
					collection: "tasks",
					id: "shared",
					payload: { text: "While absent" },
				},
				{
					type: "set",
					collection: "tasks",
					value: {
						id: "new",
						projectId: "alpha",
						text: "New arrival",
						done: false,
						priority: 8,
					},
				},
			],
		})
		await world.drain()
		expect(world.subscriptions("client2").size).toBe(0)
		expect(right.snapshots).toEqual(rightSnapshots)
		await world.apply(8, {
			type: "subscribe",
			client: "client2",
			id: "left",
			spec,
		})
		await world.drain()
		expect(world.subscriptions("client2").get("left")?.latest).toEqual([
			{ id: "new", text: "New arrival" },
			{ id: "shared", text: "While absent" },
		])
		expect(left.snapshots).toEqual(leftSnapshots)
		expect(right.snapshots).toEqual(rightSnapshots)
	})

	it("reinstalls desired subscriptions after a crash without reviving old observations", async () => {
		await using world = await DstWorld.start({
			seed: 43,
			clientCount: 2,
			initialSubscriptions: "none",
		})
		const spec = {
			kind: "tasks",
			projectId: "alpha",
			done: false,
			minPriority: 3,
			limit: 1,
			offset: 0,
			projection: true,
		} as const
		await world.apply(0, {
			type: "subscribe",
			client: "client2",
			id: "desired",
			spec,
		})
		await world.apply(1, {
			type: "subscribe",
			client: "client2",
			id: "removed",
			spec,
		})
		await world.apply(2, {
			type: "unsubscribe",
			client: "client2",
			id: "removed",
		})
		await world.apply(3, {
			type: "subscribe",
			client: "client1",
			id: "editor",
			spec: { kind: "inventory", collection: "tasks" },
		})
		await world.apply(4, {
			type: "mutate",
			client: "client1",
			ops: [
				{
					type: "set",
					collection: "tasks",
					value: {
						id: "old",
						projectId: "alpha",
						text: "Before crash",
						done: false,
						priority: 5,
					},
				},
			],
		})
		await world.drain()
		const old = world.subscriptions("client2").get("desired")!
		expect(old.latest).toEqual([{ id: "old", text: "Before crash" }])
		const snapshots = structuredClone(old.snapshots)
		await world.apply(5, { type: "crash", client: "client2" })
		expect(world.subscriptions("client2").size).toBe(0)
		await world.apply(6, {
			type: "mutate",
			client: "client1",
			ops: [
				{
					type: "update",
					collection: "tasks",
					id: "old",
					payload: { done: true },
				},
				{
					type: "set",
					collection: "tasks",
					value: {
						id: "replacement",
						projectId: "alpha",
						text: "During crash",
						done: false,
						priority: 7,
					},
				},
				{
					type: "set",
					collection: "tasks",
					value: {
						id: "excluded",
						projectId: "beta",
						text: "Not this view",
						done: false,
						priority: 20,
					},
				},
			],
		})
		await world.drain()
		await world.apply(7, { type: "restart", client: "client2" })
		await world.drain()
		expect([...world.subscriptions("client2").keys()]).toEqual(["desired"])
		expect(world.subscriptions("client2").get("desired")?.latest).toEqual([
			{ id: "replacement", text: "During crash" },
		])
		await world.apply(8, {
			type: "mutate",
			client: "client1",
			ops: [
				{
					type: "update",
					collection: "tasks",
					id: "replacement",
					payload: { text: "After restart" },
				},
			],
		})
		await world.drain()
		expect(world.subscriptions("client2").get("desired")?.latest).toEqual([
			{ id: "replacement", text: "After restart" },
		])
		expect(old.latest).toEqual([{ id: "old", text: "Before crash" }])
		expect(old.snapshots).toEqual(snapshots)
	})

	it("publishes whole local batches, including related records and ordered set-update operations", async () => {
		await using world = await DstWorld.start({
			seed: 44,
			clientCount: 1,
			initialSubscriptions: "none",
		})
		await world.apply(0, {
			type: "subscribe",
			client: "client1",
			id: "project",
			spec: {
				kind: "projectTasks",
				projectId: "alpha",
				limit: 2,
				commentLimit: 2,
			},
		})
		await world.apply(1, {
			type: "subscribe",
			client: "client1",
			id: "task",
			spec: { kind: "taskComments", taskId: "work", limit: 2 },
		})
		await world.drain()
		await world.apply(2, {
			type: "mutate",
			client: "client1",
			ops: [
				{
					type: "set",
					collection: "tasks",
					value: {
						id: "work",
						projectId: "alpha",
						text: "Intermediate",
						done: false,
						priority: 1,
					},
				},
				{
					type: "update",
					collection: "tasks",
					id: "work",
					payload: { text: "Committed", done: true, priority: 6 },
				},
				{
					type: "set",
					collection: "projects",
					value: { id: "alpha", name: "Complete project" },
				},
				{
					type: "set",
					collection: "comments",
					value: { id: "kept", taskId: "work", body: "Complete comment" },
				},
				{
					type: "set",
					collection: "comments",
					value: { id: "transient", taskId: "work", body: "Never visible" },
				},
				{ type: "remove", collection: "comments", id: "transient" },
			],
		})
		await world.drain()
		const project = [
			{
				id: "alpha",
				name: "Complete project",
				tasks: [
					{
						id: "work",
						projectId: "alpha",
						text: "Committed",
						done: true,
						priority: 6,
						comments: [
							{ id: "kept", taskId: "work", body: "Complete comment" },
						],
					},
				],
			},
		]
		const task = [
			{
				id: "work",
				projectId: "alpha",
				text: "Committed",
				done: true,
				priority: 6,
				project: { id: "alpha", name: "Complete project" },
				comments: [{ id: "kept", taskId: "work", body: "Complete comment" }],
			},
		]
		const projectView = world.subscriptions("client1").get("project")!
		const taskView = world.subscriptions("client1").get("task")!
		expect(projectView.latest).toEqual(project)
		expect(taskView.latest).toEqual(task)
		expect(projectView.snapshots).toContainEqual(project)
		expect(taskView.snapshots).toContainEqual(task)
		// Empty before the commit or the complete batch: never a partial task,
		// missing parent/comment, or the temporary comment from inside the batch.
		for (const snapshot of projectView.snapshots)
			expect([[], project]).toContainEqual(snapshot)
		for (const snapshot of taskView.snapshots)
			expect([[], task]).toContainEqual(snapshot)
	})

	it("replaces the same subscription ID while an old subscribe-and-refresh response is held", async () => {
		await using world = await DstWorld.start({
			seed: 46,
			clientCount: 2,
			initialSubscriptions: "none",
		})
		await world.apply(0, {
			type: "subscribe",
			client: "client1",
			id: "editor",
			spec: { kind: "inventory", collection: "tasks" },
		})
		await world.apply(1, {
			type: "mutate",
			client: "client1",
			ops: [
				{
					type: "set",
					collection: "tasks",
					value: {
						id: "alpha-task",
						projectId: "alpha",
						text: "Alpha only",
						done: false,
						priority: 4,
					},
				},
				{
					type: "set",
					collection: "tasks",
					value: {
						id: "beta-task",
						projectId: "beta",
						text: "Beta only",
						done: true,
						priority: 8,
					},
				},
			],
		})
		let step = 2
		for (let handoff = 0; handoff < 100; handoff++) {
			await world.settle()
			if (
				world.mutationsInFlight === 0 &&
				world.subscriptions("client1").get("editor")!.latest.length === 2
			)
				break
			const call = world
				.pending()
				.find(({ label }) => !label.includes("Timer."))
			expect(call).toBeDefined()
			await world.apply(step++, { type: "advance", call: call!.name })
		}
		expect(world.mutationsInFlight).toBe(0)
		expect(world.subscriptions("client1").get("editor")!.latest).toHaveLength(2)
		await world.apply(step++, {
			type: "subscribe",
			client: "client2",
			id: "view",
			spec: {
				kind: "tasks",
				projectId: "alpha",
				done: false,
				minPriority: 0,
				limit: 2,
				offset: 0,
				projection: true,
			},
		})
		await world.settle()
		let response = world
			.pending()
			.find(({ label }) => label === "client2.observe")
		for (
			let handoff = 0;
			handoff < 30 &&
			!(response?.sentBy === "server" && response.waitingFor === "client2");
			handoff++
		) {
			expect(response).toBeDefined()
			await world.apply(step++, { type: "advance", call: response!.name })
			await world.settle()
			response = world
				.pending()
				.find(({ label }) => label === "client2.observe")
		}
		expect(response).toMatchObject({ sentBy: "server", waitingFor: "client2" })
		const old = world.subscriptions("client2").get("view")!
		expect(old.latest).toEqual([])
		const oldSnapshots = structuredClone(old.snapshots)
		const replacement = {
			kind: "tasks",
			projectId: "beta",
			done: true,
			minPriority: 5,
			limit: 1,
			offset: 0,
			projection: true,
		} as const
		await world.apply(step++, {
			type: "subscribe",
			client: "client2",
			id: "view",
			spec: replacement,
		})
		// Deliver the old alpha response after the beta subscribe-and-refresh action.
		await world.apply(step++, { type: "advance", call: response!.name })
		await world.settle()
		expect(world.subscriptions("client2").get("view")?.spec).toEqual(
			replacement,
		)
		expect(world.subscriptions("client2").get("view")?.latest).toEqual([])
		expect(
			world.query({
				client: "client2",
				query: {
					collection: "tasks",
					where: { projectId: "alpha" },
					select: { id: true, text: true },
				},
			}),
		).toEqual([{ id: "alpha-task", text: "Alpha only" }])
		expect(old.snapshots).toEqual(oldSnapshots)
		const result = await world.finish()
		expect(result.violation).toBeUndefined()
		expect([...world.subscriptions("client2").keys()]).toEqual(["view"])
		expect(world.subscriptions("client2").get("view")?.spec).toEqual(
			replacement,
		)
		expect(world.subscriptions("client2").get("view")?.latest).toEqual([
			{ id: "beta-task", text: "Beta only" },
		])
		expect(old.latest).toEqual([])
		expect(old.snapshots).toEqual(oldSnapshots)
	})

	it("recovers a lost request that changes filter membership and replaces the leading page", async () => {
		await using world = await DstWorld.start({
			seed: 45,
			clientCount: 2,
			initialSubscriptions: "none",
		})
		await world.apply(0, {
			type: "subscribe",
			client: "client1",
			id: "editor",
			spec: { kind: "inventory", collection: "tasks" },
		})
		await world.apply(1, {
			type: "subscribe",
			client: "client2",
			id: "page",
			spec: {
				kind: "tasks",
				projectId: "alpha",
				done: false,
				minPriority: 2,
				limit: 1,
				offset: 0,
				projection: true,
			},
		})
		await world.apply(2, {
			type: "mutate",
			client: "client1",
			ops: [
				{
					type: "set",
					collection: "tasks",
					value: {
						id: "leader",
						projectId: "alpha",
						text: "Before transition",
						done: false,
						priority: 9,
					},
				},
				{
					type: "set",
					collection: "tasks",
					value: {
						id: "successor",
						projectId: "alpha",
						text: "Waiting",
						done: false,
						priority: 3,
					},
				},
			],
		})
		let step = 3
		// Keep gates active until the transition: drain intentionally disables them.
		for (let handoff = 0; handoff < 100; handoff++) {
			await world.settle()
			if (
				world.mutationsInFlight === 0 &&
				world.subscriptions("client2").get("page")!.latest.length > 0
			)
				break
			const call = world
				.pending()
				.find(({ label }) => !label.includes("Timer."))
			expect(call).toBeDefined()
			await world.apply(step++, { type: "advance", call: call!.name })
		}
		expect(world.subscriptions("client2").get("page")?.latest).toEqual([
			{ id: "leader", text: "Before transition" },
		])
		expect(world.mutationsInFlight).toBe(0)
		await world.apply(step++, {
			type: "mutate",
			client: "client1",
			ops: [
				{
					type: "update",
					collection: "tasks",
					id: "leader",
					payload: { done: true },
				},
				{
					type: "update",
					collection: "tasks",
					id: "successor",
					payload: { text: "After transition", priority: 8 },
				},
			],
		})
		await world.settle()
		let outbound = world
			.pending()
			.find(({ label }) => label === "client1.commit")
		for (
			let handoff = 0;
			handoff < 30 && outbound?.waitingFor !== "server";
			handoff++
		) {
			expect(outbound).toBeDefined()
			await world.apply(step++, { type: "advance", call: outbound!.name })
			await world.settle()
			outbound = world.pending().find(({ label }) => label === "client1.commit")
		}
		expect(outbound?.waitingFor).toBe("server")
		const dropped = await world.apply(step++, {
			type: "drop",
			call: outbound!.name,
		})
		expect(dropped).toMatchObject({ type: "drop", fault: "requestLost" })
		const result = await world.finish()
		expect(result.violation).toBeUndefined()
		expect(result.states.server.tasks).toEqual([
			{
				id: "leader",
				projectId: "alpha",
				text: "Before transition",
				done: true,
				priority: 9,
			},
			{
				id: "successor",
				projectId: "alpha",
				text: "After transition",
				done: false,
				priority: 8,
			},
		])
		expect(world.subscriptions("client2").get("page")?.latest).toEqual([
			{ id: "successor", text: "After transition" },
		])
	})
})
