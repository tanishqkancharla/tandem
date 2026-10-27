import { describe, expect, it } from "vitest"
import fs from "node:fs"
import { parseArtifact, replay } from "./DstReplay.js"
import { expectedView, subscriptionQuery } from "./DstSubscriptions.js"
import { DstWorld, type DstInventory } from "./DstWorld.js"

// Deliberately not in query order; unrelated rows distinguish filtering from
// sorting, pagination, and relation limits. Expected results below are literal.
const inventory: DstInventory = {
	projects: [
		{ id: "beta", name: "Other project" },
		{ id: "empty", name: "No tasks" },
		{ id: "alpha", name: "Main project" },
	],
	tasks: [
		{
			id: "zeta",
			projectId: "alpha",
			text: "Later tied ID",
			done: false,
			priority: 8,
		},
		{
			id: "foreign",
			projectId: "beta",
			text: "Wrong project, highest priority",
			done: false,
			priority: 30,
		},
		{
			id: "done",
			projectId: "alpha",
			text: "Wrong status",
			done: true,
			priority: 20,
		},
		{
			id: "low",
			projectId: "alpha",
			text: "Below threshold",
			done: false,
			priority: 1,
		},
		{
			id: "top",
			projectId: "alpha",
			text: "Skipped by offset",
			done: false,
			priority: 12,
		},
		{
			id: "orphan",
			projectId: "missing",
			text: "No parent project",
			done: true,
			priority: 7,
		},
		{
			id: "a",
			projectId: "alpha",
			text: "Earlier tied ID",
			done: false,
			priority: 8,
		},
	],
	comments: [
		{ id: "z-top", taskId: "top", body: "Later top comment" },
		{ id: "0-unrelated", taskId: "foreign", body: "Not a child" },
		{ id: "b-done", taskId: "done", body: "Later done comment" },
		{ id: "a-top", taskId: "top", body: "First top comment" },
		{ id: "orphan-child", taskId: "orphan", body: "Still attached" },
		{ id: "a-done", taskId: "done", body: "First done comment" },
		{ id: "dangling", taskId: "absent-task", body: "Missing task" },
	],
	memberships: [
		{ id: ["a,b", "c"], role: "Delimiter in project" },
		{ id: ["a", "b,c"], role: "Delimiter in member" },
		{ id: ["a", "b"], role: "Second member" },
		{ id: ["a", "a"], role: "First member" },
	],
}

describe("DST server-relative expected views", () => {
	it("orders an inventory by ID, not insertion order", () => {
		expect(
			expectedView(inventory, { kind: "inventory", collection: "projects" }),
		).toEqual([
			{ id: "alpha", name: "Main project" },
			{ id: "beta", name: "Other project" },
			{ id: "empty", name: "No tasks" },
		])
	})

	it("preserves every component of tuple identities, including delimiter collisions", () => {
		expect(
			expectedView(inventory, {
				kind: "inventory",
				collection: "memberships",
			}),
		).toEqual([
			{ id: ["a", "a"], role: "First member" },
			{ id: ["a", "b"], role: "Second member" },
			{ id: ["a", "b,c"], role: "Delimiter in member" },
			{ id: ["a,b", "c"], role: "Delimiter in project" },
		])
	})

	it("applies both equality filters and the inclusive threshold before offset and the ID tie-break", () => {
		expect(
			expectedView(inventory, {
				kind: "tasks",
				projectId: "alpha",
				done: false,
				minPriority: 8,
				limit: 2,
				offset: 1,
				projection: false,
			}),
		).toEqual([
			{
				id: "a",
				projectId: "alpha",
				text: "Earlier tied ID",
				done: false,
				priority: 8,
			},
			{
				id: "zeta",
				projectId: "alpha",
				text: "Later tied ID",
				done: false,
				priority: 8,
			},
		])
	})

	it("projects only the selected fields after choosing a nonzero-offset page", () => {
		expect(
			expectedView(inventory, {
				kind: "tasks",
				projectId: "alpha",
				done: false,
				minPriority: 8,
				limit: 1,
				offset: 2,
				projection: true,
			}),
		).toEqual([{ id: "zeta", text: "Later tied ID" }])
	})

	it("does not invent optional task filters, and distinguishes true from false", () => {
		expect(
			expectedView(inventory, {
				kind: "tasks",
				minPriority: 8,
				limit: 3,
				offset: 0,
				projection: true,
			}),
		).toEqual([
			{ id: "foreign", text: "Wrong project, highest priority" },
			{ id: "done", text: "Wrong status" },
			{ id: "top", text: "Skipped by offset" },
		])
		expect(
			expectedView(inventory, {
				kind: "tasks",
				done: true,
				minPriority: 0,
				limit: 3,
				offset: 0,
				projection: true,
			}),
		).toEqual([
			{ id: "done", text: "Wrong status" },
			{ id: "orphan", text: "No parent project" },
		])
	})

	it("joins the matching project and limits comments after filtering and sorting", () => {
		expect(
			expectedView(inventory, {
				kind: "taskComments",
				taskId: "top",
				limit: 1,
			}),
		).toEqual([
			{
				id: "top",
				projectId: "alpha",
				text: "Skipped by offset",
				done: false,
				priority: 12,
				project: { id: "alpha", name: "Main project" },
				comments: [{ id: "a-top", taskId: "top", body: "First top comment" }],
			},
		])
	})

	it("keeps a task and its children when its one-to-one parent is missing", () => {
		expect(
			expectedView(inventory, {
				kind: "taskComments",
				taskId: "orphan",
				limit: 2,
			}),
		).toEqual([
			{
				id: "orphan",
				projectId: "missing",
				text: "No parent project",
				done: true,
				priority: 7,
				project: null,
				comments: [
					{ id: "orphan-child", taskId: "orphan", body: "Still attached" },
				],
			},
		])
	})

	it("applies independent limits to a project's tasks and each task's comments", () => {
		expect(
			expectedView(inventory, {
				kind: "projectTasks",
				projectId: "alpha",
				limit: 2,
				commentLimit: 1,
			}),
		).toEqual([
			{
				id: "alpha",
				name: "Main project",
				tasks: [
					{
						id: "done",
						projectId: "alpha",
						text: "Wrong status",
						done: true,
						priority: 20,
						comments: [
							{ id: "a-done", taskId: "done", body: "First done comment" },
						],
					},
					{
						id: "top",
						projectId: "alpha",
						text: "Skipped by offset",
						done: false,
						priority: 12,
						comments: [
							{ id: "a-top", taskId: "top", body: "First top comment" },
						],
					},
				],
			},
		])
	})

	it("does not synthesize missing roots from dangling children and keeps empty joins", () => {
		expect(
			expectedView(inventory, {
				kind: "taskComments",
				taskId: "absent-task",
				limit: 2,
			}),
		).toEqual([])
		expect(
			expectedView(inventory, {
				kind: "projectTasks",
				projectId: "missing",
				limit: 2,
				commentLimit: 2,
			}),
		).toEqual([])
		expect(
			expectedView(inventory, {
				kind: "projectTasks",
				projectId: "empty",
				limit: 2,
				commentLimit: 2,
			}),
		).toEqual([{ id: "empty", name: "No tasks", tasks: [] }])
	})
})

describe("DST isolated server-relative page", () => {
	it("reports a notification-only mismatch when the local query is correct", async () => {
		await using world = await DstWorld.start({ seed: 52, clientCount: 1 })
		await world.apply(0, {
			type: "mutate",
			client: "client1",
			ops: [
				{
					type: "set",
					collection: "projects",
					value: { id: "p", name: "Visible" },
				},
			],
		})
		await world.drain()
		const observed = world.subscriptions("client1").get("inventory-projects")!
		expect(observed.latest).toEqual([{ id: "p", name: "Visible" }])
		// Test the DST checker itself: inject a stale UI observation, not a product fault.
		observed.latest = []
		expect((await world.checkpoint("ordinary")).violation).toEqual({
			kind: "subscriptionNotification",
			checkpoint: "ordinary",
			client: "client1",
			subscriptionId: "inventory-projects",
			spec: { kind: "inventory", collection: "projects" },
			expected: [{ id: "p", name: "Visible" }],
			actual: [],
		})
	})

	it("replays the minimal sole-offset defect with the expected nonempty page", async () => {
		const artifact = parseArtifact(
			fs.readFileSync(
				new URL("./known-failures/sole-offset.jsonl", import.meta.url),
				"utf8",
			),
		)
		const result = await replay(artifact)
		expect(result.divergence).toBeUndefined()
		expect(result.violation).toEqual(artifact.outcome?.violation)
		expect(result.violation).toMatchObject({
			expected: [{ id: "b", text: "Second" }],
			actual: [],
		})
	})

	it("detects the known sole-offset page defect without warming the reader cache", async () => {
		await using world = await DstWorld.start({
			seed: 51,
			clientCount: 2,
			initialSubscriptions: "none",
		})
		// Only the editing client may retain the complete inventory. The reader
		// must get its page without another subscription warming its cache.
		await world.apply(0, {
			type: "subscribe",
			client: "client1",
			id: "editor",
			spec: { kind: "inventory", collection: "tasks" },
		})
		await world.apply(1, {
			type: "mutate",
			client: "client1",
			ops: inventory.tasks.map((value) => ({
				type: "set",
				collection: "tasks",
				value,
			})),
		})
		await world.drain()
		const spec = {
			kind: "tasks",
			projectId: "alpha",
			done: false,
			minPriority: 8,
			limit: 1,
			offset: 1,
			projection: true,
		} as const
		await world.apply(2, {
			type: "subscribe",
			client: "client2",
			id: "sole-page",
			spec,
		})

		// finish reconnects and explicitly pulls both clients; merely draining
		// existing handoffs is not enough to establish a settled remote view.
		const outcome = await world.finish()
		expect(outcome.states.server.tasks).toHaveLength(7)
		expect([...world.subscriptions("client2").keys()]).toEqual(["sole-page"])
		// This checks the DST's defect detection, not pagination correctness.
		// Remove the known-failure assertion once Tandem returns the requested row.
		expect(outcome.violation).toEqual({
			kind: "subscriptionView",
			checkpoint: "quiescence",
			client: "client2",
			subscriptionId: "sole-page",
			spec,
			expected: [{ id: "a", text: "Earlier tied ID" }],
			actual: [],
		})
		expect(
			world.query({ client: "client2", query: subscriptionQuery(spec) }),
		).toEqual([])
		expect(world.subscriptions("client2").get("sole-page")?.latest).toEqual([])
	})
})
