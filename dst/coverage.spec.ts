import { describe, expect, it } from "vitest"
import {
	aggregateCoverage,
	emptyCoverage,
	missingCoverage,
	type DstCoverage,
} from "./DstCoverage.js"
import { recover } from "./DstRecovery.js"
import { DstWorld } from "./DstWorld.js"

function completeCoverage(): DstCoverage {
	return {
		mutationsByClient: { client1: 1, client2: 1 },
		operations: Object.fromEntries(
			["projects", "tasks", "comments", "memberships"].flatMap((collection) =>
				["set", "update", "remove"].map((op) => [`${collection}.${op}`, 1]),
			),
		),
		batchSizes: { "1": 1, "3": 1 },
		multiOperationCommits: 1,
		compoundIdentityCommits: 1,
		conflictingMutations: 1,
		subscriptionChanges: 1,
		callbacks: 1,
		nonemptyCallbacks: 1,
		pageMembershipChanges: 1,
		filterMembershipChanges: 1,
		viewChecks: 1,
		nonemptyViewChecks: 1,
		offsetViewChecks: 1,
		nestedRelationChecks: 1,
		compoundViewChecks: 1,
		dropsByKind: { requestLost: 1, responseLost: 1, pokeLost: 1 },
		partitionDrops: 1,
		disconnects: 1,
		reconnects: 1,
		crashesBeforeDurability: 1,
		crashesAfterDurability: 1,
		restarts: 1,
	}
}

describe("DST executed coverage", () => {
	it("sums every metric across seeds, retains record keys, and leaves inputs unchanged", () => {
		const first = completeCoverage()
		const second = {
			...completeCoverage(),
			mutationsByClient: { client2: 2, client3: 3 },
			operations: { "tasks.set": 2, "extra.operation": 4 },
			batchSizes: { "3": 2, "5": 4 },
		}
		const original = structuredClone([first, second])

		expect(aggregateCoverage([first, second])).toEqual({
			mutationsByClient: { client1: 1, client2: 3, client3: 3 },
			operations: {
				...first.operations,
				"tasks.set": 3,
				"extra.operation": 4,
			},
			batchSizes: { "1": 1, "3": 3, "5": 4 },
			multiOperationCommits: 2,
			compoundIdentityCommits: 2,
			conflictingMutations: 2,
			subscriptionChanges: 2,
			callbacks: 2,
			nonemptyCallbacks: 2,
			pageMembershipChanges: 2,
			filterMembershipChanges: 2,
			viewChecks: 2,
			nonemptyViewChecks: 2,
			offsetViewChecks: 2,
			nestedRelationChecks: 2,
			compoundViewChecks: 2,
			dropsByKind: { requestLost: 2, responseLost: 2, pokeLost: 2 },
			partitionDrops: 2,
			disconnects: 2,
			reconnects: 2,
			crashesBeforeDurability: 2,
			crashesAfterDurability: 2,
			restarts: 2,
		})
		expect([first, second]).toEqual(original)
		expect(aggregateCoverage([])).toEqual(emptyCoverage([]))
		expect(
			aggregateCoverage([emptyCoverage(["client7"])]).mutationsByClient,
		).toEqual({ client7: 0 })
	})

	it("requires successful mutations from every configured client, except single-client conflicts", () => {
		const coverage = completeCoverage()
		coverage.mutationsByClient.client2 = 0
		expect(missingCoverage(coverage, "writes")).toEqual([
			"mutationsByClient.client2",
		])
		coverage.mutationsByClient = { client1: 1 }
		coverage.conflictingMutations = 0
		expect(missingCoverage(coverage, "writes")).toEqual([])
		coverage.mutationsByClient.client2 = 1
		expect(missingCoverage(coverage, "writes")).toEqual([
			"conflictingMutations",
		])
	})

	it.each(Object.keys(completeCoverage().operations))(
		"requires a successful %s operation, not just other operations",
		(key) => {
			const coverage = completeCoverage()
			delete coverage.operations[key]
			expect(missingCoverage(coverage, "writes")).toEqual([`operations.${key}`])
			coverage.operations[key] = 0
			expect(missingCoverage(coverage, "writes")).toEqual([`operations.${key}`])
		},
	)

	it.each([
		["writes", "multiOperationCommits"],
		["writes", "compoundIdentityCommits"],
		["subscriptions", "subscriptionChanges"],
		["subscriptions", "callbacks"],
		["subscriptions", "nonemptyCallbacks"],
		["subscriptions", "pageMembershipChanges"],
		["subscriptions", "filterMembershipChanges"],
		["subscriptions", "viewChecks"],
		["subscriptions", "nonemptyViewChecks"],
		["subscriptions", "offsetViewChecks"],
		["subscriptions", "nestedRelationChecks"],
		["subscriptions", "compoundViewChecks"],
		["faults", "partitionDrops"],
		["faults", "disconnects"],
		["faults", "reconnects"],
		["crashes", "crashesBeforeDurability"],
		["crashes", "crashesAfterDurability"],
		["crashes", "restarts"],
	] as const)("%s requires an actual nonzero %s metric", (profile, key) => {
		const coverage = completeCoverage()
		coverage[key] = 0
		expect(missingCoverage(coverage, profile)).toEqual([key])
		expect(missingCoverage(coverage, "all")).toEqual([key])
	})

	it.each(["requestLost", "responseLost", "pokeLost"] as const)(
		"requires an actual %s drop even when other faults occurred",
		(kind) => {
			const coverage = completeCoverage()
			coverage.dropsByKind[kind] = 0
			expect(missingCoverage(coverage, "faults")).toEqual([
				`dropsByKind.${kind}`,
			])
		},
	)

	it("checks the union of profile requirements over aggregate executed observations", () => {
		const first = completeCoverage()
		first.crashesAfterDurability = 0
		const second = emptyCoverage(["client1", "client2"])
		second.crashesAfterDurability = 1
		expect(missingCoverage(first, "crashes")).toEqual([
			"crashesAfterDurability",
		])
		expect(missingCoverage(aggregateCoverage([first, second]), "all")).toEqual(
			[],
		)

		const empty = emptyCoverage(["client1", "client2"])
		const profiles = ["writes", "subscriptions", "faults", "crashes"] as const
		const requirements = profiles.flatMap((profile) => {
			const missing = missingCoverage(empty, profile)
			expect(missing.length).toBeGreaterThan(0)
			return missing
		})
		expect(missingCoverage(empty, "all")).toEqual(requirements)
	})

	it("does not credit missing or empty updates, including after a remove in the same batch", async () => {
		await using world = await DstWorld.start({ seed: 93, clientCount: 1 })
		await world.apply(0, {
			type: "mutate",
			client: "client1",
			ops: [
				{
					type: "update",
					collection: "tasks",
					id: "missing",
					payload: { done: true },
				},
				{
					type: "update",
					collection: "memberships",
					id: ["p", "missing"],
					payload: { role: "editor" },
				},
			],
		})
		await world.drain()
		expect(world.coverage).toMatchObject({
			mutationsByClient: { client1: 0 },
			operations: {},
			batchSizes: {},
			multiOperationCommits: 0,
			compoundIdentityCommits: 0,
		})
		expect(world.coverage.operations).toEqual({})
		expect(world.coverage.batchSizes).toEqual({})
		await world.apply(1, {
			type: "mutate",
			client: "client1",
			ops: [
				{
					type: "set",
					collection: "tasks",
					value: {
						id: "a",
						projectId: "p",
						text: "Task",
						done: false,
						priority: 2,
					},
				},
				{
					type: "set",
					collection: "memberships",
					value: { id: ["p", "member"], role: "reader" },
				},
			],
		})
		await world.drain()
		await world.apply(2, {
			type: "mutate",
			client: "client1",
			ops: [
				{ type: "remove", collection: "tasks", id: "a" },
				{
					type: "update",
					collection: "tasks",
					id: "a",
					payload: { text: "Not recreated" },
				},
				{
					type: "update",
					collection: "memberships",
					id: ["p", "member"],
					payload: {},
				},
			],
		})
		const outcome = await world.finish()
		expect(outcome.states.server.tasks).toEqual([])
		expect(outcome.states.server.memberships).toEqual([
			{ id: ["p", "member"], role: "reader" },
		])
		expect(outcome.coverage).toMatchObject({
			mutationsByClient: { client1: 2 },
			operations: { "tasks.set": 1, "memberships.set": 1, "tasks.remove": 1 },
			batchSizes: { "1": 1, "2": 1 },
			multiOperationCommits: 1,
			compoundIdentityCommits: 1,
		})
		expect(outcome.coverage.operations["tasks.update"]).toBeUndefined()
		expect(outcome.coverage.operations["memberships.update"]).toBeUndefined()
	})

	it("requires a real predicate crossing, not initial acquisition or reordering the same page", async () => {
		await using world = await DstWorld.start({
			seed: 94,
			clientCount: 2,
			initialSubscriptions: "none",
		})
		let step = 0
		await world.apply(step++, {
			type: "subscribe",
			client: "client1",
			id: "editing",
			spec: { kind: "inventory", collection: "tasks" },
		})
		await world.apply(step++, {
			type: "mutate",
			client: "client1",
			ops: [
				{
					type: "set",
					collection: "tasks",
					value: {
						id: "a",
						projectId: "p",
						text: "A",
						done: false,
						priority: 3,
					},
				},
				{
					type: "set",
					collection: "tasks",
					value: {
						id: "b",
						projectId: "p",
						text: "B",
						done: false,
						priority: 2,
					},
				},
			],
		})
		await world.drain()
		await world.apply(step++, {
			type: "subscribe",
			client: "client2",
			id: "filtered",
			spec: {
				kind: "tasks",
				projectId: "p",
				done: false,
				minPriority: 1,
				limit: 2,
				offset: 0,
				projection: true,
			},
		})
		await world.drain()
		expect(world.coverage.filterMembershipChanges).toBe(0)
		expect(world.coverage.pageMembershipChanges).toBe(0)
		const before = world.coverage.pageMembershipChanges
		await world.apply(step++, {
			type: "mutate",
			client: "client1",
			ops: [
				{
					type: "update",
					collection: "tasks",
					id: "a",
					payload: { priority: 1 },
				},
				{
					type: "update",
					collection: "tasks",
					id: "b",
					payload: { priority: 4 },
				},
			],
		})
		await world.drain()
		expect(world.subscriptions("client2").get("filtered")?.latest).toEqual([
			{ id: "b", text: "B" },
			{ id: "a", text: "A" },
		])
		expect(world.coverage.pageMembershipChanges).toBe(before)
		expect(world.coverage.filterMembershipChanges).toBe(0)
		await world.apply(step++, {
			type: "mutate",
			client: "client1",
			ops: [
				{
					type: "update",
					collection: "tasks",
					id: "b",
					payload: { done: true },
				},
				{
					type: "update",
					collection: "tasks",
					id: "b",
					payload: { done: false },
				},
			],
		})
		await world.drain()
		expect(world.coverage.pageMembershipChanges).toBe(before)
		expect(world.coverage.filterMembershipChanges).toBe(0)
		await world.apply(step++, {
			type: "mutate",
			client: "client1",
			ops: [
				{
					type: "update",
					collection: "tasks",
					id: "b",
					payload: { done: true },
				},
			],
		})
		await world.drain()
		expect(world.subscriptions("client2").get("filtered")?.latest).toEqual([
			{ id: "a", text: "A" },
		])
		expect(world.coverage.pageMembershipChanges).toBe(before + 1)
		expect(world.coverage.filterMembershipChanges).toBe(1)
	})

	it("counts completed batches, overlapping writers, real callbacks and nonempty checked views", async () => {
		await using world = await DstWorld.start({ seed: 91 })
		let step = 0
		await world.apply(step++, {
			type: "subscribe",
			client: "client2",
			id: "page",
			spec: {
				kind: "tasks",
				minPriority: 2,
				done: false,
				limit: 1,
				offset: 1,
				projection: true,
			},
		})
		await world.apply(step++, {
			type: "subscribe",
			client: "client2",
			id: "related",
			spec: { kind: "projectTasks", projectId: "p", limit: 3, commentLimit: 2 },
		})
		await world.apply(step++, {
			type: "mutate",
			client: "client1",
			ops: [
				{
					type: "set",
					collection: "projects",
					value: { id: "p", name: "Project" },
				},
				{
					type: "set",
					collection: "tasks",
					value: {
						id: "a",
						projectId: "p",
						text: "First",
						done: false,
						priority: 4,
					},
				},
				{
					type: "set",
					collection: "tasks",
					value: {
						id: "b",
						projectId: "p",
						text: "Second",
						done: false,
						priority: 3,
					},
				},
				{
					type: "set",
					collection: "comments",
					value: { id: "c", taskId: "a", body: "Comment" },
				},
				{
					type: "set",
					collection: "memberships",
					value: { id: ["p", "member"], role: "reader" },
				},
			],
		})
		await world.apply(step++, {
			type: "mutate",
			client: "client2",
			ops: [
				{
					type: "set",
					collection: "projects",
					value: { id: "p", name: "Other writer" },
				},
			],
		})
		expect(world.coverage.mutationsByClient).toEqual({ client1: 0, client2: 0 })
		expect(world.coverage.operations).toEqual({})
		const outcome = await recover(world, {
			startStep: step,
			eventBudget: 1000,
			record: () => {},
		})
		expect(outcome.violation).toBeUndefined()
		expect(outcome.coverage).toMatchObject({
			mutationsByClient: { client1: 1, client2: 1 },
			operations: {
				"projects.set": 2,
				"tasks.set": 2,
				"comments.set": 1,
				"memberships.set": 1,
			},
			batchSizes: { "1": 1, "5": 1 },
			multiOperationCommits: 1,
			compoundIdentityCommits: 1,
			conflictingMutations: 1,
			subscriptionChanges: 2,
		})
		for (const key of [
			"callbacks",
			"nonemptyCallbacks",
			"nonemptyViewChecks",
			"offsetViewChecks",
			"nestedRelationChecks",
			"compoundViewChecks",
		] as const)
			expect(outcome.coverage[key], key).toBeGreaterThan(0)
		expect(world.subscriptions("client2").get("page")?.latest).toEqual([
			{ id: "b", text: "Second" },
		])
	})

	it.each(["before", "after"] as const)(
		"records a crash %s the durable write and verifies restart survival through public views",
		async (side) => {
			await using world = await DstWorld.start({ seed: 92, clientCount: 1 })
			let step = 0
			await world.apply(step++, {
				type: "mutate",
				client: "client1",
				ops: [
					{
						type: "set",
						collection: "projects",
						value: { id: "cutpoint", name: "Durable record" },
					},
				],
			})
			// Stop at the storage adapter's actual entry/exit, not an optimistic callback.
			for (let count = 0; count < 10; count++) {
				await world.settle()
				const call = world
					.pending()
					.find(({ label }) => label === "client1.commit")!
				if (
					side === "before"
						? call.waitingFor === "client1Storage"
						: call.sentBy === "client1Storage"
				)
					break
				await world.apply(step++, { type: "advance", call: call.name })
			}
			const boundary = world
				.pending()
				.find(({ label }) => label === "client1.commit")!
			expect(side === "before" ? boundary.waitingFor : boundary.sentBy).toBe(
				"client1Storage",
			)
			await world.apply(step++, { type: "crash", client: "client1" })
			expect(world.coverage).toMatchObject({
				crashesBeforeDurability: side === "before" ? 1 : 0,
				crashesAfterDurability: side === "after" ? 1 : 0,
				mutationsByClient: { client1: 0 },
			})
			const outcome = await recover(world, {
				startStep: step,
				eventBudget: 1000,
				record: () => {},
			})
			const expected =
				side === "after" ? [{ id: "cutpoint", name: "Durable record" }] : []
			expect(outcome.violation).toBeUndefined()
			expect(outcome.states.server.projects).toEqual(expected)
			expect(outcome.states.client1.projects).toEqual(expected)
			expect(outcome.coverage.restarts).toBe(1)
		},
	)
})
