import type {
	RelationalQuery,
	TandemClient,
} from "@tanishqkancharla/tandem-core"
import type { DstInventory, DstSchema, dstRelations } from "./DstWorld.js"

/** Closed, JSON-serializable application queries, not a query interpreter. */
export type DstSubscriptionSpec =
	| { kind: "inventory"; collection: keyof DstSchema }
	| {
			kind: "tasks"
			projectId?: string
			done?: boolean
			minPriority: number
			limit: number
			offset: number
			projection: boolean
	  }
	| { kind: "taskComments"; taskId: string; limit: number }
	| { kind: "taskStats" }
	| {
			kind: "projectTasks"
			projectId: string
			limit: number
			commentLimit: number
	  }

export type DstSubscriptionMode = "full" | "scoped" | "none"

export function subscriptionQuery(
	spec: Exclude<DstSubscriptionSpec, { kind: "taskStats" }>,
): RelationalQuery<DstSchema, typeof dstRelations> {
	switch (spec.kind) {
		case "inventory":
			return { collection: spec.collection, orderBy: { id: "asc" } }
		case "tasks":
			return {
				collection: "tasks",
				where: {
					...(spec.projectId === undefined
						? {}
						: { projectId: spec.projectId }),
					...(spec.done === undefined ? {} : { done: spec.done }),
					priority: { gte: spec.minPriority },
				},
				orderBy: { priority: "desc", id: "asc" },
				limit: spec.limit,
				offset: spec.offset,
				...(spec.projection ? { select: { id: true, text: true } } : {}),
			}
		case "taskComments":
			return {
				collection: "tasks",
				where: { id: spec.taskId },
				with: {
					project: true,
					comments: { orderBy: { id: "asc" }, limit: spec.limit },
				},
			}
		case "projectTasks":
			return {
				collection: "projects",
				where: { id: spec.projectId },
				with: {
					tasks: {
						orderBy: { priority: "desc", id: "asc" },
						limit: spec.limit,
						with: {
							comments: { orderBy: { id: "asc" }, limit: spec.commentLimit },
						},
					},
				},
			}
	}
}

function taskStatsQuery() {
	return {
		collection: "tasks" as const,
		where: { done: false },
		groupBy: ["projectId"] as const,
		aggregate: (rows: readonly DstSchema["tasks"][]) => ({
			count: rows.length,
			averagePriority:
				rows.reduce((sum, row) => sum + row.priority, 0) / rows.length,
		}),
	}
}

export function querySubscription(
	client: TandemClient<DstSchema, typeof dstRelations>,
	spec: DstSubscriptionSpec,
): unknown[] {
	return spec.kind === "taskStats"
		? client.query(taskStatsQuery())
		: client.query(subscriptionQuery(spec))
}

export function subscribeToSpec(
	client: TandemClient<DstSchema, typeof dstRelations>,
	spec: DstSubscriptionSpec,
	callback: (rows: unknown[]) => void,
) {
	return spec.kind === "taskStats"
		? client.subscribe(taskStatsQuery(), callback)
		: client.subscribe(subscriptionQuery(spec), callback)
}

function compareString(a: string, b: string): number {
	return a < b ? -1 : a > b ? 1 : 0
}

function compareIdentity(
	a: { id: string | readonly string[] },
	b: { id: string | readonly string[] },
): number {
	const left = typeof a.id === "string" ? [a.id] : a.id
	const right = typeof b.id === "string" ? [b.id] : b.id
	for (let i = 0; i < Math.min(left.length, right.length); i++) {
		const compared = compareString(left[i]!, right[i]!)
		if (compared !== 0) return compared
	}
	return left.length - right.length
}

function taskOrder(a: DstSchema["tasks"], b: DstSchema["tasks"]): number {
	return b.priority - a.priority || compareString(a.id, b.id)
}

export function matchesTask(
	task: DstSchema["tasks"],
	spec: Extract<DstSubscriptionSpec, { kind: "tasks" }>,
): boolean {
	return (
		(spec.projectId === undefined || task.projectId === spec.projectId) &&
		(spec.done === undefined || task.done === spec.done) &&
		task.priority >= spec.minPriority
	)
}

/** Direct views of current server records; never applies or predicts mutations. */
export function expectedView(
	inventory: DstInventory,
	spec: DstSubscriptionSpec,
): unknown[] {
	const comments = (taskId: string, limit: number) =>
		inventory.comments
			.filter((comment) => comment.taskId === taskId)
			.sort(compareIdentity)
			.slice(0, limit)
	switch (spec.kind) {
		case "taskStats": {
			const groups = new Map<string, DstSchema["tasks"][]>()
			for (const task of inventory.tasks) {
				if (task.done) continue
				const rows = groups.get(task.projectId) ?? []
				rows.push(task)
				groups.set(task.projectId, rows)
			}
			return [...groups]
				.sort(([left], [right]) => compareString(left, right))
				.map(([projectId, rows]) => ({
					projectId,
					count: rows.length,
					averagePriority:
						rows.reduce((sum, row) => sum + row.priority, 0) / rows.length,
				}))
		}
		case "inventory":
			return [...inventory[spec.collection]].sort(compareIdentity)
		case "tasks": {
			const rows = inventory.tasks
				.filter((task) => matchesTask(task, spec))
				.sort(taskOrder)
				.slice(spec.offset, spec.offset + spec.limit)
			return spec.projection ? rows.map(({ id, text }) => ({ id, text })) : rows
		}
		case "taskComments":
			return inventory.tasks
				.filter(({ id }) => id === spec.taskId)
				.map((task) => ({
					...task,
					project:
						inventory.projects.find(({ id }) => id === task.projectId) ?? null,
					comments: comments(task.id, spec.limit),
				}))
		case "projectTasks":
			return inventory.projects
				.filter(({ id }) => id === spec.projectId)
				.map((project) => ({
					...project,
					tasks: inventory.tasks
						.filter(({ projectId }) => projectId === project.id)
						.sort(taskOrder)
						.slice(0, spec.limit)
						.map((task) => ({
							...task,
							comments: comments(task.id, spec.commentLimit),
						})),
				}))
	}
}
