import type {
	AnySchema,
	RelationalQuery,
	RelationalQueryResult,
	RemoteApi,
} from "@tanishqkancharla/tandem-core"
import { TandemClient } from "@tanishqkancharla/tandem-core"
import {
	InMemoryRemoteStore,
	TandemServer,
} from "@tanishqkancharla/tandem-server"
import { expect, test as base, vi } from "vitest"
import {
	taskRelations,
	taskSchema,
	type TaskRelations,
	type TaskSchema,
} from "./taskSchema"

export { project, task } from "./taskSchema"
export type {
	ProjectRecord,
	TaskRecord,
	TaskRelations,
	TaskSchema,
} from "./taskSchema"

export type TaskTandemServer = TandemServer<TaskSchema, TaskRelations>
export type TaskTandemClient = TandemClient<TaskSchema, TaskRelations>
export type TaskQuery = RelationalQuery<TaskSchema, TaskRelations>

export function expectQuery<Query extends TaskQuery>(
	client: TaskTandemClient,
	query: Query,
) {
	return {
		async toResolveTo(
			expected: RelationalQueryResult<TaskSchema, TaskRelations, Query>,
		) {
			await vi.waitFor(() => {
				expect(client.query(query)).toEqual(expected)
			})
		},
	}
}

export type MakeClientOptions = {
	label?: string
	remote?: RemoteApi<TaskSchema>
}

export type ServerHandle = {
	server: TaskTandemServer
	makeClient: (options?: MakeClientOptions) => Promise<TaskTandemClient>
	close: () => Promise<void>
}

function createServerHandle(): ServerHandle {
	const server = new TandemServer<TaskSchema, TaskRelations>({
		schema: taskSchema,
		relations: taskRelations,
		store: new InMemoryRemoteStore(),
	})

	const clients: TaskTandemClient[] = []
	let clientCount = 0
	let closed = false

	return {
		server,
		async makeClient(connectOptions = {}) {
			clientCount += 1
			const tandemClient = new TandemClient<TaskSchema, TaskRelations>({
				relations: taskRelations,
				remote: connectOptions.remote ?? server,
				rng: {
					randomId: () =>
						connectOptions.label ?? `server-client-${clientCount}`,
				},
				schema: taskSchema,
				syncInterval: 0,
			})
			await tandemClient.ready
			clients.push(tandemClient)
			return tandemClient
		},
		async close() {
			if (closed) return
			closed = true
			for (const client of clients) {
				await client.disconnect()
			}
			await server.destroy()
		},
	}
}

function createPushGate<Schema extends AnySchema>(inner: RemoteApi<Schema>) {
	let holding = false
	let allowPush = () => {}
	let notifyHeld = () => {}
	let untilAllow = Promise.resolve()
	let untilHeld = Promise.resolve()

	function hold() {
		holding = true
		untilAllow = new Promise<void>((resolve) => {
			allowPush = resolve
		})
		untilHeld = new Promise<void>((resolve) => {
			notifyHeld = resolve
		})
	}

	function allow() {
		holding = false
		allowPush()
	}

	const remote: RemoteApi<Schema> = {
		connect: (api) => inner.connect(api),
		pull: (args) => inner.pull(args),
		push: async (args) => {
			if (holding) {
				notifyHeld()
				await untilAllow
			}
			return inner.push(args)
		},
	}

	return {
		remote,
		hold,
		allow,
		waitUntilHeld: () => untilHeld,
	}
}

type ServerFixtures = {
	serverHandle: ServerHandle
	server: TaskTandemServer
	makeClient: ServerHandle["makeClient"]
	makePushGate: () => ReturnType<typeof createPushGate<TaskSchema>>
}

export const test = base.extend<ServerFixtures>({
	serverHandle: async ({}, use) => {
		const handle = createServerHandle()
		await use(handle)
		await handle.close()
	},

	server: async ({ serverHandle }, use) => {
		await use(serverHandle.server)
	},

	makeClient: async ({ serverHandle }, use) => {
		await use(serverHandle.makeClient)
	},

	makePushGate: async ({ server }, use) => {
		const gates: ReturnType<typeof createPushGate<TaskSchema>>[] = []
		await use(() => {
			const gate = createPushGate(server)
			gates.push(gate)
			return gate
		})
		for (const gate of gates) {
			gate.allow()
		}
	},
})
