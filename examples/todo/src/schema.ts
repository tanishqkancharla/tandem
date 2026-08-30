import { collection, defineSchema, t } from "@get-halo/tandem-core"

export const schema = defineSchema({
	todos: collection({
		id: t.id(),
		text: t.string(),
		complete: t.boolean(),
		createdAt: t.number(),
	}),
})

export type Todo = {
	id: string
	text: string
	complete: boolean
	createdAt: number
}

export type TodoSchema = {
	todos: Todo
}
