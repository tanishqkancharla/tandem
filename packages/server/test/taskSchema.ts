import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core"

export const projects = sqliteTable("projects", {
	id: text("id").primaryKey(),
	name: text("name").notNull(),
})

export const tasks = sqliteTable("tasks", {
	id: text("id").primaryKey(),
	title: text("title").notNull().unique(),
	done: integer("done", { mode: "boolean" }).notNull(),
	priority: integer("priority").notNull(),
	projectId: text("project_id"),
})

export const taskTables = {
	projects,
	tasks,
}

export const taskSqlSchema = `
	create table projects (
		id text primary key,
		name text not null
	);

	create table tasks (
		id text primary key,
		title text not null unique,
		done integer not null,
		priority integer not null,
		project_id text
	);
`

export type ProjectRecord = typeof projects.$inferSelect
export type TaskRecord = typeof tasks.$inferSelect

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
