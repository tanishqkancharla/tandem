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
			// Batched commits need more handoffs; keep the workload per client.
			const steps = 1000 * clientCount
			const result = await new DstSimulation({
				seed: 3,
				steps,
				clientCount,
				connectivityRate: 0,
			}).execute(sink)
			const names = Array.from(
				{ length: clientCount },
				(_, i): `client${number}` => `client${i + 1}`,
			)

			expect(result.violation).toBeUndefined()
			for (const records of Object.values(result.states.server))
				expect(records.length).toBeGreaterThan(0)
			expect(Object.keys(result.states)).toEqual(["server", ...names])
			expect(new Set(result.clientIds).size).toBe(clientCount)
			for (const name of names)
				expect(result.states[name]).toEqual(result.states.server)
			expect(
				new Set(
					result.trace.flatMap((event) =>
						event.type === "mutate" ? [event.client] : [],
					),
				),
			).toEqual(new Set(names))
			expect(sink.lines[0]).toEqual({
				kind: "header",
				format: 1,
				options: {
					seed: 3,
					steps,
					clientCount,
					recordCount: 3,
					maxMutationsInFlight: 4,
					sharedWriteRate: 1,
					namedAppendRate: 0,
					faultRate: 0,
					crashRate: 0,
					tabs: 0,
					initialSubscriptions: "full",
					subscriptionRate: 0.08,
					connectivityRate: 0,
					recoveryEvents: clientCount * 500,
				},
			})
		},
		30_000,
	)

	it("moves relations, preserves children of deleted parents, and keeps collections isolated", async () => {
		await using world = await DstWorld.start({ seed: 2 })
		await world.apply(0, {
			type: "mutate",
			client: "client1",
			ops: [
				{
					type: "set",
					collection: "projects",
					value: { id: "shared", name: "Original project" },
				},
			],
		})
		await world.apply(1, {
			type: "mutate",
			client: "client1",
			ops: [
				{
					type: "set",
					collection: "projects",
					value: { id: "other", name: "Other project" },
				},
			],
		})
		await world.apply(2, {
			type: "mutate",
			client: "client1",
			ops: [
				{
					type: "set",
					collection: "tasks",
					value: {
						id: "shared",
						projectId: "shared",
						text: "Original task",
						done: false,
						priority: 2,
					},
				},
			],
		})
		await world.apply(3, {
			type: "mutate",
			client: "client1",
			ops: [
				{
					type: "set",
					collection: "tasks",
					value: {
						id: "orphan",
						projectId: "missing",
						text: "Dangling task",
						done: true,
						priority: 5,
					},
				},
			],
		})
		await world.apply(4, {
			type: "mutate",
			client: "client1",
			ops: [
				{
					type: "set",
					collection: "comments",
					value: { id: "shared", taskId: "shared", body: "Move me" },
				},
			],
		})
		await world.finish()

		expect(
			world.query({
				client: "client2",
				query: {
					collection: "projects",
					where: { id: "shared" },
					select: { id: true },
					with: {
						tasks: {
							select: { id: true },
							with: { comments: { select: { body: true } } },
						},
					},
				},
			}),
		).toEqual([
			{
				id: "shared",
				tasks: [{ id: "shared", comments: [{ body: "Move me" }] }],
			},
		])
		expect(
			world.query({
				client: "client2",
				query: {
					collection: "tasks",
					where: { id: "orphan" },
					select: { id: true },
					with: { project: true },
				},
			}),
		).toEqual([{ id: "orphan", project: null }])

		await world.apply(5, {
			type: "mutate",
			client: "client2",
			ops: [
				{
					type: "update",
					collection: "tasks",
					id: "shared",
					payload: { projectId: "other" },
				},
			],
		})
		await world.apply(6, {
			type: "mutate",
			client: "client2",
			ops: [
				{
					type: "update",
					collection: "comments",
					id: "shared",
					payload: { taskId: "orphan" },
				},
			],
		})
		await world.finish()
		expect(
			world.query({
				client: "client1",
				query: {
					collection: "projects",
					select: { id: true },
					orderBy: { id: "asc" },
					with: {
						tasks: {
							select: { id: true },
							with: { comments: { select: { body: true } } },
						},
					},
				},
			}),
		).toEqual([
			{ id: "other", tasks: [{ id: "shared", comments: [] }] },
			{ id: "shared", tasks: [] },
		])
		expect(
			world.query({
				client: "client1",
				query: {
					collection: "comments",
					select: { id: true },
					with: { task: { select: { id: true } } },
				},
			}),
		).toEqual([{ id: "shared", task: { id: "orphan" } }])

		// Removing the same string ID in one collection neither cascades nor crosses collections.
		await world.apply(7, {
			type: "mutate",
			client: "client1",
			ops: [
				{
					type: "remove",
					collection: "projects",
					id: "shared",
				},
			],
		})
		await world.apply(8, {
			type: "mutate",
			client: "client1",
			ops: [
				{
					type: "remove",
					collection: "projects",
					id: "other",
				},
			],
		})
		const removed = await world.finish()
		expect(removed.violation).toBeUndefined()
		expect(removed.states.server.projects).toEqual([])
		expect(removed.states.server.tasks).toHaveLength(2)
		expect(removed.states.server.comments).toEqual([
			{ id: "shared", taskId: "orphan", body: "Move me" },
		])
		expect(
			world.query({
				client: "client2",
				query: {
					collection: "tasks",
					where: { id: "shared" },
					select: { text: true },
					with: { project: true },
				},
			}),
		).toEqual([{ text: "Original task", project: null }])

		await world.apply(9, {
			type: "mutate",
			client: "client2",
			ops: [
				{
					type: "set",
					collection: "projects",
					value: { id: "other", name: "Recreated project" },
				},
			],
		})
		const recreated = await world.finish()
		expect(recreated.violation).toBeUndefined()
		expect(
			world.query({
				client: "client1",
				query: {
					collection: "tasks",
					where: { id: "shared" },
					select: { id: true },
					with: { project: { select: { name: true } } },
				},
			}),
		).toEqual([{ id: "shared", project: { name: "Recreated project" } }])
	})

	it("updates, removes, and recreates full compound identities across durable restarts", async () => {
		await using world = await DstWorld.start({ seed: 2, clientCount: 3 })
		const memberships = [
			{ id: ["project1", "member1"], role: "owner" },
			{ id: ["project1", "member2"], role: "editor" },
			{ id: ["project2", "member1"], role: "reader" },
		] as const
		for (const [step, value] of memberships.entries())
			await world.apply(step, {
				type: "mutate",
				client: "client1",
				ops: [
					{
						type: "set",
						collection: "memberships",
						value,
					},
				],
			})
		await world.finish()
		await world.apply(3, {
			type: "mutate",
			client: "client2",
			ops: [
				{
					type: "update",
					collection: "memberships",
					id: ["project1", "member1"],
					payload: { role: "reader" },
				},
			],
		})
		await world.apply(4, {
			type: "mutate",
			client: "client3",
			ops: [
				{
					type: "remove",
					collection: "memberships",
					id: ["project1", "member2"],
				},
			],
		})
		const removed = await world.finish()
		expect(removed.violation).toBeUndefined()
		expect(removed.states.server.memberships).toEqual([
			{ id: ["project1", "member1"], role: "reader" },
			{ id: ["project2", "member1"], role: "reader" },
		])

		await world.apply(5, {
			type: "mutate",
			client: "client2",
			ops: [
				{
					type: "set",
					collection: "memberships",
					value: { id: ["project1", "member2"], role: "owner" },
				},
			],
		})
		await world.finish()
		await world.apply(6, { type: "crash", client: "client1" })
		await world.apply(7, { type: "restart", client: "client1" })
		const restarted = await world.finish()
		expect(restarted.violation).toBeUndefined()
		expect(restarted.states.server.memberships).toEqual([
			{ id: ["project1", "member1"], role: "reader" },
			{ id: ["project1", "member2"], role: "owner" },
			{ id: ["project2", "member1"], role: "reader" },
		])
		for (const client of world.clientNames)
			expect(restarted.states[client]).toEqual(restarted.states.server)
	})

	it("commits ordered repeated identities and related records as one mutation", async () => {
		await using world = await DstWorld.start({ seed: 2 })
		await world.apply(0, {
			type: "mutate",
			client: "client1",
			ops: [
				{
					type: "set",
					collection: "projects",
					value: { id: "project", name: "Batch project" },
				},
				{
					type: "set",
					collection: "tasks",
					value: {
						id: "updated",
						projectId: "project",
						text: "Before update",
						done: false,
						priority: 1,
					},
				},
				{
					type: "update",
					collection: "tasks",
					id: "updated",
					payload: { text: "After update", done: true },
				},
				{
					type: "set",
					collection: "comments",
					value: { id: "discarded", taskId: "updated", body: "Remove me" },
				},
				{ type: "remove", collection: "comments", id: "discarded" },
				{
					type: "set",
					collection: "tasks",
					value: {
						id: "recreated",
						projectId: "missing",
						text: "Before removal",
						done: true,
						priority: 9,
					},
				},
				{ type: "remove", collection: "tasks", id: "recreated" },
				{
					type: "set",
					collection: "tasks",
					value: {
						id: "recreated",
						projectId: "project",
						text: "After recreation",
						done: false,
						priority: 2,
					},
				},
				{
					type: "set",
					collection: "comments",
					value: { id: "kept", taskId: "recreated", body: "Related in batch" },
				},
			],
		})
		await world.settle()
		// Each batch holds one commit, not a separately schedulable commit per op.
		expect(world.mutationsInFlight).toBe(1)
		expect(world.pending().map(({ label }) => label)).toEqual([
			"client1.commit",
		])

		const result = await world.finish()
		expect(result.violation).toBeUndefined()
		expect(result.states.server).toEqual({
			projects: [{ id: "project", name: "Batch project" }],
			tasks: [
				{
					id: "recreated",
					projectId: "project",
					text: "After recreation",
					done: false,
					priority: 2,
				},
				{
					id: "updated",
					projectId: "project",
					text: "After update",
					done: true,
					priority: 1,
				},
			],
			comments: [{ id: "kept", taskId: "recreated", body: "Related in batch" }],
			memberships: [],
		})
		for (const client of world.clientNames)
			expect(result.states[client]).toEqual(result.states.server)
		expect(
			world.query({
				client: "client2",
				query: {
					collection: "projects",
					select: { name: true },
					with: {
						tasks: {
							select: { text: true, done: true },
							orderBy: { id: "asc" },
							with: { comments: { select: { body: true } } },
						},
					},
				},
			}),
		).toEqual([
			{
				name: "Batch project",
				tasks: [
					{
						text: "After recreation",
						done: false,
						comments: [{ body: "Related in batch" }],
					},
					{ text: "After update", done: true, comments: [] },
				],
			},
		])
	})

	it.each(["client1", "client2"] as const)(
		"preserves disjoint offline field updates when %s edits completion",
		async (completionClient) => {
			await using world = await DstWorld.start({ seed: 2 })
			await world.apply(0, {
				type: "mutate",
				client: "client1",
				ops: [
					{
						type: "set",
						collection: "tasks",
						value: {
							id: "shared",
							projectId: "project",
							text: "Original",
							done: false,
							priority: 3,
						},
					},
				],
			})
			// Both clients receive the base and disconnect before editing it.
			await world.finish()
			await world.apply(1, {
				type: "mutate",
				client: completionClient,
				ops: [
					{
						type: "update",
						collection: "tasks",
						id: "shared",
						payload: { done: true, priority: 8 },
					},
				],
			})
			await world.apply(2, {
				type: "mutate",
				client: completionClient === "client1" ? "client2" : "client1",
				ops: [
					{
						type: "update",
						collection: "tasks",
						id: "shared",
						payload: { text: "Concurrent title" },
					},
				],
			})

			const result = await world.finish()
			// Convergence alone would also pass if the server replaced the whole record.
			expect(result.states.server.tasks).toEqual([
				{
					id: "shared",
					projectId: "project",
					text: "Concurrent title",
					done: true,
					priority: 8,
				},
			])
			expect(result.violation).toBeUndefined()
			expect(result.states.client1).toEqual(result.states.server)
			expect(result.states.client2).toEqual(result.states.server)
		},
	)

	it("applies a named append through shared client and server code", async () => {
		await using world = await DstWorld.start({ seed: 2 })
		const task = {
			id: "item-1",
			projectId: "project",
			text: "Start",
			done: false,
			priority: 3,
		}
		await world.apply(0, { type: "serverSet", item: task })
		await world.finish()
		await world.apply(1, {
			type: "namedAppend",
			client: "client1",
			id: task.id,
			text: " A",
		})
		await world.apply(2, {
			type: "namedAppend",
			client: "client2",
			id: task.id,
			text: " B",
		})
		await world.apply(3, {
			type: "namedAppend",
			client: "client1",
			id: task.id,
			text: "!",
			field: "note",
		})
		const result = await world.finish()
		expect(result.states.server.tasks[0]?.text).toBe("Start A B")
		expect(result.states.server.tasks[0]?.note).toBe("!")
		expect(result.states.client1).toEqual(result.states.server)
		expect(result.states.client2).toEqual(result.states.server)
		expect(world.stats.namedAppendCommits).toBe(3)
		expect(result.violation).toBeUndefined()
	})

	it.each([
		{ seed: 5, steps: 300, faultRate: 0.1, namedAppendRate: 0.15 },
		{
			seed: 6,
			steps: 300,
			faultRate: 0.1,
			crashRate: 0.02,
			namedAppendRate: 0.15,
		},
	])(
		"exercises named appends under faults and crashes: %j",
		async (options) => {
			const sink = memorySink()
			const result = await new DstSimulation(options).execute(sink)
			expect(result.trace.some(({ type }) => type === "namedAppend")).toBe(true)
			expect(
				result.trace.some(
					(record) => record.type === "namedAppend" && record.field === "note",
				),
			).toBe(true)
			expect(result.stats.namedAppendCommits).toBeGreaterThan(0)
			expect(result.violation).toBeUndefined()
			const replayed = await replay(parseArtifact(formatArtifact(sink.lines)))
			expect(replayed.divergence).toBeUndefined()
			expect(replayed.violation).toEqual(result.violation)
		},
	)

	it("settles a final lost request by reconnecting and delivering retained writes", async () => {
		await using world = await DstWorld.start({ seed: 2 })
		const item = {
			id: "item-3",
			projectId: "project",
			text: "Retained write",
			done: true,
			priority: 1,
		}
		await world.apply(0, {
			type: "mutate",
			client: "client1",
			ops: [
				{
					type: "set",
					collection: "tasks",
					value: item,
				},
			],
		})
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
		expect(result.states.server.tasks).toEqual([item])
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
				subscriptionRate: 0,
				connectivityRate: 0,
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
			projectId: "project",
			text: `From ${client}`,
			done: false,
			priority: index + 1,
		}))
		for (const [index, client] of world.clientNames.entries()) {
			await world.apply(index, {
				type: "mutate",
				client,
				ops: [
					{
						type: "set",
						collection: "tasks",
						value: items[index],
					},
				],
			})
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
		expect(result.states.server.tasks).toEqual(items)
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
				connectivityRate: 0,
			}).execute()
			const ids = result.trace.flatMap((event) => {
				if (event.type !== "mutate") return []
				return event.ops.map((op) => {
					const id = matchBy(op, "type", {
						set: ({ value }) => value.id,
						update: ({ id }) => id,
						remove: ({ id }) => id,
					})
					const prefix =
						sharedWriteRate === 1 ? "item-" : `${event.client}-item-`
					const poolId = typeof id === "string" ? id : id[1]
					expect(poolId.startsWith(prefix)).toBe(true)
					return Number(poolId.slice(prefix.length))
				})
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

		const serverOwnedWrites = result.trace.filter(
			(record) =>
				(record.type === "serverSet" &&
					serverOwnedIds.includes(record.item.id)) ||
				(record.type === "serverAppend" && serverOwnedIds.includes(record.id)),
		)
		expect(serverOwnedWrites.length).toBeGreaterThan(5)
		// Appended text reached clients live, not only through pulls.
		expect(result.stats.appendPayloadsDelivered).toBeGreaterThan(0)
		expect(
			result.trace.some(
				(record) => record.type === "drop" && record.fault === "pokeLost",
			),
		).toBe(true)
		expect(result.violation).toBeUndefined()
	})

	it("merges bursts of server appends into single payloads under faults", async () => {
		const result = await new DstSimulation({
			seed: 12,
			steps: 300,
			faultRate: 0.1,
			crashRate: 0.02,
		}).execute()

		expect(result.trace.some(({ type }) => type === "serverTick")).toBe(true)
		// Text from several commits reached a client as one append.
		expect(result.stats.mergedAppendsDelivered).toBeGreaterThan(0)
		expect(result.violation).toBeUndefined()
	})

	it("delivers live task payloads before pulls and ignores an older held poke", async () => {
		await using world = await DstWorld.start({ seed: 7 })
		const first = {
			id: "reply-1",
			projectId: "p",
			text: "First chunk",
			done: false,
			priority: 2,
		}
		const second = { ...first, text: "Second chunk" }
		await world.apply(0, { type: "serverSet", item: first })
		await world.settle()
		const older = world.pending().find(({ label }) => label === "client1.poke")!
		await world.apply(1, { type: "serverSet", item: second })
		await world.settle()
		await world.apply(2, { type: "serverTick" })
		await world.settle()
		const newer = world
			.pending()
			.find(
				({ label, name }) => label === "client1.poke" && name !== older.name,
			)!

		await world.apply(3, { type: "advance", call: newer.name })
		await world.settle()
		expect(world.inventoryOf("client1").tasks).toEqual([second])
		expect(
			world.subscriptions("client1").get("inventory-tasks")?.latest,
		).toEqual([second])
		// The confirming pull has not passed its local debounce timer yet.
		expect(world.pending()).toContainEqual(
			expect.objectContaining({ name: newer.name, sentBy: "client1Timer" }),
		)
		await world.apply(4, { type: "advance", call: older.name })
		await world.settle()
		expect(world.inventoryOf("client1").tasks).toEqual([second])
		expect(
			world.subscriptions("client1").get("inventory-tasks")?.snapshots,
		).not.toContainEqual([first])

		await world.apply(5, { type: "serverRemove", id: first.id })
		await world.settle()
		await world.apply(6, { type: "serverTick" })
		await world.settle()
		const removal = world
			.pending()
			.find(
				({ label, sentBy }) => label === "client1.poke" && sentBy === "server",
			)!
		await world.apply(7, { type: "advance", call: removal.name })
		await world.settle()
		expect(world.inventoryOf("client1").tasks).toEqual([])
		expect((await world.finish()).violation).toBeUndefined()
	})

	it("allows scoped readers to evict server-owned tasks without an ordering violation", async () => {
		await using world = await DstWorld.start({
			seed: 7,
			clientCount: 1,
			initialSubscriptions: "none",
		})
		await world.apply(0, {
			type: "subscribe",
			client: "client1",
			id: "page",
			spec: { kind: "inventory", collection: "tasks" },
		})
		await world.apply(1, {
			type: "serverSet",
			item: {
				id: "reply-1",
				projectId: "alpha",
				text: "Visible before replacement",
				done: false,
				priority: 2,
			},
		})
		await world.drain()
		expect((await world.checkpoint("ordinary")).violation).toBeUndefined()
		expect(world.inventoryOf("client1").tasks).toHaveLength(1)
		await world.apply(2, {
			type: "subscribe",
			client: "client1",
			id: "page",
			spec: {
				kind: "tasks",
				projectId: "beta",
				minPriority: 0,
				limit: 2,
				offset: 0,
				projection: false,
			},
		})
		await world.drain()
		expect(world.inventoryOf("client1").tasks).toEqual([])
		expect([...world.subscriptions("client1").keys()]).toEqual(["page"])
		expect((await world.finish()).violation).toBeUndefined()
	})

	it("replays a fault-and-crash run to the same final outcome", async () => {
		const sink = memorySink()
		const run = await new DstSimulation({
			seed: 2,
			steps: 4000,
			faultRate: 0.1,
			crashRate: 0.02,
			clientCount: 5,
			recordCount: 3,
			maxMutationsInFlight: 3,
			sharedWriteRate: 0.4,
		}).execute(sink)

		const replayed = await replay(parseArtifact(formatArtifact(sink.lines)))

		const batches = run.trace.filter((record) => record.type === "mutate")
		expect(new Set(batches.map(({ ops }) => ops.length))).toEqual(
			new Set([1, 2, 3, 4]),
		)
		expect(
			batches.some(
				({ ops }) => new Set(ops.map((op) => op.collection)).size > 1,
			),
		).toBe(true)
		for (const pair of ["set,update", "set,remove", "remove,set"]) {
			expect(
				batches.some(({ ops }) =>
					ops.some((op, index) => {
						const next = ops[index + 1]
						if (
							!next ||
							`${op.type},${next.type}` !== pair ||
							op.collection !== next.collection
						)
							return false
						const id = matchBy(op, "type", {
							set: ({ value }) => value.id,
							update: ({ id }) => id,
							remove: ({ id }) => id,
						})
						const nextId = matchBy(next, "type", {
							set: ({ value }) => value.id,
							update: ({ id }) => id,
							remove: ({ id }) => id,
						})
						return JSON.stringify(id) === JSON.stringify(nextId)
					}),
				),
			).toBe(true)
		}
		const mutationOps = run.trace.flatMap((record) =>
			record.type === "mutate" ? record.ops : [],
		)
		const operations = new Set(
			mutationOps.map((op) => `${op.collection}.${op.type}`),
		)
		for (const collection of ["projects", "tasks", "comments", "memberships"])
			for (const operation of ["set", "update", "remove"])
				expect(operations).toContain(`${collection}.${operation}`)
		expect(
			mutationOps.some(
				(op) =>
					op.type === "update" &&
					op.collection === "tasks" &&
					"projectId" in op.payload,
			),
		).toBe(true)
		expect(
			mutationOps.some(
				(op) =>
					op.type === "update" &&
					op.collection === "comments" &&
					"taskId" in op.payload,
			),
		).toBe(true)
		expect(run.trace.some((record) => record.type === "crash")).toBe(true)
		expect(run.trace.some((record) => record.type === "drop")).toBe(true)

		const updates = mutationOps.filter(
			(op) => op.type === "update" && op.collection === "tasks",
		)
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
			recovery: run.recovery,
		})
	}, 15_000)

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

	it("reports the historical crash recording's incompatible schedule, not a fixed defect", async () => {
		const artifact = parseArtifact(
			readFileSync(
				new URL("./known-failures/crash-removal.jsonl", import.meta.url),
				"utf8",
			),
		)
		const result = await replay(artifact)

		// Live-poke payloads changed the pending schedule. Keep the original
		// artifact intact: rejecting its schedule is not proof the ghost is fixed.
		expect(result.stepsCompleted).toBeLessThan(artifact.options.steps)
		expect(result.divergence).toMatchObject({
			expected: { type: "advance", call: "client1.poke#1" },
			reason: "the event applied differently",
		})
		expect(result.violation).toBeUndefined()
		expect(result.recovery).toBeUndefined()
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
