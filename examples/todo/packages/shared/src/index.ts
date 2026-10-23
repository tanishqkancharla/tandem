import {
	codec,
	collection,
	defineSchema,
	literal,
	oneOf,
	partialObject,
	string,
	t,
	type RemoteApi,
} from "@tanishqkancharla/tandem-core"

const number = codec<number, number>(
	"number",
	(value) => {
		if (typeof value !== "number" || !Number.isFinite(value))
			throw new Error("Expected a finite number")
		return value
	},
	(value) => {
		if (typeof value !== "number" || !Number.isFinite(value))
			throw new Error("Expected a finite number")
		return value
	},
)

export const schema = defineSchema({
	todos: collection(
		{
			id: t.id(),
			text: t.string(),
			complete: t.boolean(),
			createdAt: t.number(),
		},
		{
			codec: partialObject({
				id: string,
				text: string,
				complete: oneOf(literal(true), literal(false)),
				createdAt: number,
			}),
		},
	),
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
export type TodoPushResult = Awaited<ReturnType<RemoteApi<TodoSchema>["push"]>>
export type TodoPullArgs = Parameters<RemoteApi<TodoSchema>["pull"]>[0]
export type TodoPullResult = Awaited<ReturnType<RemoteApi<TodoSchema>["pull"]>>

export type TodoRemoteRequest =
	| { action: "pull"; args: TodoPullArgs }
	| { action: "push"; args: TodoPushArgs }
