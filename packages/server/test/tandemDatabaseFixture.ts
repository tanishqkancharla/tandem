import type {
	AnySchema,
	RelationalQuery,
	RelationalQueryResult,
	RemoteApi,
} from "@tanishqkancharla/tandem-core"
import { TandemClient } from "@tanishqkancharla/tandem-core"
import { TandemDatabase } from "@tanishqkancharla/tandem-server"
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

export type TaskTandemDatabase = TandemDatabase<TaskSchema, TaskRelations>
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

export type DatabaseHandle = {
	database: TaskTandemDatabase
	makeClient: (options?: MakeClientOptions) => Promise<TaskTandemClient>
	close: () => Promise<void>
}

function createDatabaseHandle(): DatabaseHandle {
	const database = new TandemDatabase<TaskSchema, TaskRelations>({
		schema: taskSchema,
		relations: taskRelations,
	})

	const clients: TaskTandemClient[] = []
	let clientCount = 0
	let closed = false

	return {
		database,
		async makeClient(connectOptions = {}) {
			clientCount += 1
			const tandemClient = new TandemClient<TaskSchema, TaskRelations>({
				relations: taskRelations,
				remote: connectOptions.remote ?? database,
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
			await database.destroy()
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

type DatabaseFixtures = {
	databaseHandle: DatabaseHandle
	database: TaskTandemDatabase
	makeClient: DatabaseHandle["makeClient"]
	makePushGate: () => ReturnType<typeof createPushGate<TaskSchema>>
}

export const test = base.extend<DatabaseFixtures>({
	databaseHandle: async ({}, use) => {
		const handle = createDatabaseHandle()
		await use(handle)
		await handle.close()
	},

	database: async ({ databaseHandle }, use) => {
		await use(databaseHandle.database)
	},

	makeClient: async ({ databaseHandle }, use) => {
		await use(databaseHandle.makeClient)
	},

	makePushGate: async ({ database }, use) => {
		const gates: ReturnType<typeof createPushGate<TaskSchema>>[] = []
		await use(() => {
			const gate = createPushGate(database)
			gates.push(gate)
			return gate
		})
		for (const gate of gates) {
			gate.allow()
		}
	},
})
