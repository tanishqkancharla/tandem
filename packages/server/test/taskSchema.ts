import {
	collection,
	defineRelations,
	defineSchema,
	type RuntimeSchemaDefinition,
} from "@tanishqkancharla/tandem-core"

export type ProjectRecord = {
	id: string
	name: string
}

export type TaskRecord = {
	id: string
	title: string
	done: boolean
	priority: number
	projectId: string | null
}

export type TaskSchema = {
	projects: ProjectRecord
	tasks: TaskRecord
}

export const taskSchema = defineSchema({
	projects: collection<ProjectRecord>({ fields: ["id", "name"] }),
	tasks: collection<TaskRecord>({
		fields: ["id", "title", "done", "priority", "projectId"],
	}),
}) satisfies RuntimeSchemaDefinition<TaskSchema>

export const taskRelations = defineRelations(taskSchema, ({ one, many }) => ({
	tasks: {
		project: one("projects", { from: "projectId", to: "id" }),
	},
	projects: {
		tasks: many("tasks", { from: "id", to: "projectId" }),
	},
}))

export type TaskRelations = typeof taskRelations

export function project(id: string, name: string): ProjectRecord {
	return { id, name }
}

export function task(
	id: string,
	title: string,
	overrides: Partial<Omit<TaskRecord, "id" | "title">> = {},
): TaskRecord {
	return {
		id,
		title,
		done: false,
		priority: 1,
		projectId: null,
		...overrides,
	}
}
