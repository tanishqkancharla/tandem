import {
	collection,
	defineSchema,
	t,
	type RemoteApi,
} from "@tanishqkancharla/tandem-core"

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

export type TodoPushArgs = Parameters<RemoteApi<TodoSchema>["push"]>[0]
export type TodoPullArgs = Parameters<RemoteApi<TodoSchema>["pull"]>[0]
export type TodoPullResult = Awaited<ReturnType<RemoteApi<TodoSchema>["pull"]>>

export type TodoRemoteRequest =
	| { action: "pull"; args: TodoPullArgs }
	| { action: "push"; args: TodoPushArgs }
