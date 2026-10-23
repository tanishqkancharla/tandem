import {
	collection,
	defineSchema,
	t,
	type RuntimeSchemaDefinition,
} from "@tanishqkancharla/tandem-core"

export type Todo = {
	id: string
	title: string
	done: boolean
	createdAt: number
}

export type TodoSchema = { todos: Todo }

export const todoSchema = defineSchema({
	todos: collection({
		id: t.id(),
		title: t.string(),
		done: t.boolean(),
		createdAt: t.number(),
	}),
}) satisfies RuntimeSchemaDefinition<TodoSchema>
