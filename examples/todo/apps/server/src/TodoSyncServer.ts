import type {
	ClientId,
	Cookie,
	EncodedQuery,
	Mutation,
	MutationId,
	PatchRemoveOp,
	PatchSetOp,
	RelationalQuery,
	RemoteApi,
} from "@tanishqkancharla/tandem-core"
import { untag } from "@tanishqkancharla/tandem-core"
import {
	TandemServer,
	TandemServerJsonFileStorage,
} from "@tanishqkancharla/tandem-server"
import { schema, type TodoSchema } from "@tandem/example-todo-shared"
import * as errore from "errore"

type ClientState = {
	lastMutationId?: MutationId
	scanWindowKey?: string
	syncedIds?: Set<string>
}

class TodoSyncServerError extends errore.createTaggedError({
	name: "TodoSyncServerError",
	message: "Todo sync server failed to $operation",
}) {}

const relationalOperator = {
	">": "gt",
	"<": "lt",
	">=": "gte",
	"<=": "lte",
} as const

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value)
}

function decodeTodoQuery(
	query: EncodedQuery<TodoSchema>,
): RelationalQuery<TodoSchema, {}> {
	const where: Record<string, unknown> = {}
	for (const [field, operator, value] of query.where ?? []) {
		if (operator === "=") {
			where[field] = value
			continue
		}

		const previous = isRecord(where[field]) ? where[field] : {}
		where[field] = { ...previous, [relationalOperator[operator]]: value }
	}

	return {
		collection: "todos",
		...(query.where?.length ? { where } : {}),
		...(query.order?.length
			? { orderBy: Object.fromEntries(query.order) }
			: {}),
		...(query.limit === undefined ? {} : { limit: query.limit }),
		...(query.offset === undefined ? {} : { offset: query.offset }),
	} as RelationalQuery<TodoSchema, {}>
}

export class TodoSyncServer {
	// TODO: Replace these in-memory cookies and client snapshots with the
	// durable per-client sync protocol when that TandemServer phase begins.
	private readonly clients = new Map<ClientId, ClientState>()
	private readonly mutations: Mutation<TodoSchema>[] = []

	constructor(private readonly server: TandemServer<TodoSchema, {}>) {}

	push: RemoteApi<TodoSchema>["push"] = async ({ clientId, mutations }) => {
		if (mutations.length === 0) return

		const transaction = this.server.transact()
		for (const mutation of mutations) {
			for (const operation of mutation.ops) {
				if (operation.type === "set") {
					transaction.set("todos", operation.value)
					continue
				}
				transaction.remove("todos", operation.id)
			}
		}

		const committed = await this.server
			.commit(transaction)
			.catch((cause) => new TodoSyncServerError({ operation: "push", cause }))
		if (committed instanceof Error) throw committed

		this.mutations.push(...mutations)
		this.clients.set(clientId, {
			...this.clients.get(clientId),
			lastMutationId: mutations.at(-1)?.id,
		})
	}

	pull: RemoteApi<TodoSchema>["pull"] = async ({
		clientId,
		cookie,
		scanWindow,
	}) => {
		const client = this.clients.get(clientId) ?? {}
		const scanWindowKey = JSON.stringify(scanWindow)
		const scanWindowChanged = client.scanWindowKey !== scanWindowKey
		const rawCookie = cookie === undefined ? 0 : untag(cookie)
		const mutationIndex = typeof rawCookie === "number" ? rawCookie : 0
		const mutations = this.mutations.slice(mutationIndex)
		const queries = scanWindow.filter(
			(query): query is EncodedQuery<TodoSchema, "todos"> =>
				query.collection === "todos",
		)
		const shouldReadSnapshot =
			cookie === undefined || scanWindowChanged || mutations.length > 0
		const setById = new Map<string, PatchSetOp<TodoSchema>>()
		const removeById = new Map<string, PatchRemoveOp<TodoSchema>>()

		if (shouldReadSnapshot) {
			for (const query of queries) {
				const todos = await this.server
					.query(decodeTodoQuery(query))
					.catch(
						(cause) => new TodoSyncServerError({ operation: "pull", cause }),
					)
				if (todos instanceof Error) throw todos

				for (const todo of todos) {
					setById.set(todo.id, { collection: "todos", value: todo })
				}
			}
		}

		if (shouldReadSnapshot) {
			for (const id of client.syncedIds ?? []) {
				if (!setById.has(id)) {
					removeById.set(id, { collection: "todos", id })
				}
			}

			for (const mutation of mutations) {
				for (const operation of mutation.ops) {
					if (operation.type === "set" && !setById.has(operation.value.id)) {
						removeById.set(operation.value.id, {
							collection: "todos",
							id: operation.value.id,
						})
					}
					if (operation.type === "remove") {
						removeById.set(operation.id, {
							collection: "todos",
							id: operation.id,
						})
					}
				}
			}
		}

		this.clients.set(clientId, {
			scanWindowKey,
			syncedIds: shouldReadSnapshot
				? new Set(setById.keys())
				: client.syncedIds,
		})

		return {
			cookie: this.mutations.length as Cookie,
			patch: {
				set: Array.from(setById.values()),
				remove: Array.from(removeById.values()),
			},
			lastMutationId: client.lastMutationId,
		}
	}

	close() {
		return this.server.close()
	}
}

export async function createTodoSyncServer({ filePath }: { filePath: string }) {
	const server = new TandemServer({
		schema,
		relations: {},
		storage: new TandemServerJsonFileStorage<TodoSchema>({ filePath }),
	})
	const todos = await server
		.query({ collection: "todos" })
		.catch((cause) => new TodoSyncServerError({ operation: "seed", cause }))
	if (todos instanceof Error) return todos
	if (todos.length > 0) return new TodoSyncServer(server)

	const seed = server.transact()
	seed.set("todos", {
		id: "welcome",
		text: "Build something with Tandem",
		complete: false,
		createdAt: Date.now(),
	})
	seed.set("todos", {
		id: "maui",
		text: "Style it with Maui color tokens",
		complete: true,
		createdAt: Date.now() - 1,
	})
	const seeded = await server
		.commit(seed)
		.catch((cause) => new TodoSyncServerError({ operation: "seed", cause }))
	if (seeded instanceof Error) return seeded

	return new TodoSyncServer(server)
}
