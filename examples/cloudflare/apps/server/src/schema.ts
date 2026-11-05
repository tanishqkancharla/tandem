import {
	collection,
	defineSchema,
	t,
	type RemoteApi,
} from "@tanishqkancharla/tandem-core"

export type Task = { id: string; text: string; done: boolean }
export type AppSchema = { tasks: Task }

export const schema = defineSchema({
	tasks: collection({ id: t.id(), text: t.string(), done: t.boolean() }),
})

export type SyncRequest =
	| { action: "push"; args: Parameters<RemoteApi<AppSchema>["push"]>[0] }
	| { action: "pull"; args: Parameters<RemoteApi<AppSchema>["pull"]>[0] }
