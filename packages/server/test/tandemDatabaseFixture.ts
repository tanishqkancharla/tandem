import type {
	AnySchema,
	LoggerApi,
	RelationalQuery,
	RelationalQueryResult,
	RemoteApi,
} from "@tanishqkancharla/tandem-core"
import { TandemClient } from "@tanishqkancharla/tandem-core"
import { defineRelations } from "@tanishqkancharla/tandem-core"
import {
	deriveTandemSchema,
	TandemDatabase,
	type SchemaFromDrizzleTables,
} from "@tanishqkancharla/tandem-server"
import { connect, type Database } from "@tursodatabase/database"
import { drizzle } from "drizzle-orm/sqlite-proxy"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, test as base, vi } from "vitest"
import { SQLiteDrizzleAdapter } from "../src/drizzle/sqlite"
import { taskSqlSchema, taskTables } from "./taskSchema"

export { project, task, taskTables } from "./taskSchema"
export type { ProjectRecord, TaskRecord } from "./taskSchema"

const silentLogger: LoggerApi = {
	debug() {},
	log() {},
	info() {},
	warn() {},
	error() {},
	scope() {
		return silentLogger
	},
}

export type TaskSchema = SchemaFromDrizzleTables<typeof taskTables>
export type TaskClientSchema = ReturnType<
	typeof deriveTandemSchema<typeof taskTables>
>
export type TaskRelations = ReturnType<typeof createTaskRelations>
export type TaskTandemDatabase = TandemDatabase<TaskSchema, TaskRelations>
export type TaskTandemClient = TandemClient<TaskSchema, TaskRelations>
export type TaskQuery = RelationalQuery<TaskSchema, TaskRelations>

function createTaskRelations(clientSchema: TaskClientSchema) {
	return defineRelations(clientSchema, ({ one, many }) => ({
		tasks: {
			project: one("projects", { from: "projectId", to: "id" }),
		},
		projects: {
			tasks: many("tasks", { from: "id", to: "projectId" }),
		},
	}))
}

function createTursoDrizzle(client: Database) {
	// Drizzle 0.44 does not ship drizzle-orm/tursodatabase/database. The
	// fixture still opens real embedded Turso and presents a Drizzle SQLite
	// database to the public adapter.
	return drizzle(async (sql, params, method) => {
		if (method === "run") {
			await client.run(sql, ...params)
			return { rows: [] }
		}

		if (method === "get") {
			const row = await client.get(sql, ...params)
			return { rows: row ? [Object.values(row)] : [] }
		}

		const rows = await client.all(sql, ...params)
		return { rows: rows.map((row) => Object.values(row)) }
	})
}

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

export type OpenDatabaseOptions = {
	filePath?: string
	createTables?: boolean
}

export type MakeClientOptions = {
	label?: string
	remote?: RemoteApi<TaskSchema>
	subscribe?: TaskQuery
}

export type DatabaseHandle = {
	filePath: string
	ownedDir?: string
	database: TaskTandemDatabase
	clientSchema: TaskClientSchema
	relations: TaskRelations
	makeClient: (options?: MakeClientOptions) => Promise<TaskTandemClient>
	close: () => Promise<void>
}

type ConnectedClient = {
	client: TaskTandemClient
	subscriptions: { destroy: () => void }[]
}

function queriesFrom(subscribe: MakeClientOptions["subscribe"]): TaskQuery[] {
	return subscribe == null ? [] : [subscribe]
}

async function createDatabaseHandle(
	options: OpenDatabaseOptions = {},
): Promise<DatabaseHandle> {
	const createTables = options.createTables ?? true
	const ownedDir = options.filePath
		? undefined
		: await mkdtemp(join(tmpdir(), "tandem-turso-"))
	const filePath = options.filePath ?? join(ownedDir!, "tandem.db")
	const native = await connect(filePath)
	try {
		if (createTables) {
			await native.exec(taskSqlSchema)
		}

		const db = createTursoDrizzle(native)
		const clientSchema = deriveTandemSchema(taskTables)
		const relations = createTaskRelations(clientSchema)
		const database = new TandemDatabase({
			adapter: new SQLiteDrizzleAdapter({
				db,
				tables: taskTables as any,
			}),
			schema: clientSchema,
			relations,
		})

		const connectedClients: ConnectedClient[] = []
		let clientCount = 0
		let closed = false

		return {
			filePath,
			ownedDir,
			clientSchema,
			relations,
			database,
			async makeClient(connectOptions = {}) {
				clientCount += 1
				const tandemClient = new TandemClient<TaskSchema, TaskRelations>({
					autoConnect: false,
					logger: silentLogger,
					relations,
					remote: connectOptions.remote ?? database,
					rng: {
						randomId: () =>
							connectOptions.label ?? `turso-client-${clientCount}`,
					},
					schema: clientSchema,
					syncInterval: 0,
				})
				await tandemClient.ready
				await tandemClient.connect()
				const subscriptions = queriesFrom(connectOptions.subscribe).map(
					(query) => tandemClient.subscribe(query, () => {}),
				)
				connectedClients.push({ client: tandemClient, subscriptions })
				return tandemClient
			},
			async close() {
				if (closed) return
				closed = true
				for (const { client, subscriptions } of connectedClients) {
					for (const subscription of subscriptions) {
						subscription.destroy()
					}
					await client.disconnect()
				}
				await database.destroy()
				await native.close()
			},
		}
	} catch (error) {
		await native.close()
		if (ownedDir) {
			await rm(ownedDir, { recursive: true, force: true })
		}
		throw error
	}
}

function createGatedPushRemote<Schema extends AnySchema>(
	inner: RemoteApi<Schema>,
) {
	let armed = false
	let releasePush = () => {}
	let notifyGate = () => {}
	let hold = Promise.resolve()
	let gate = Promise.resolve()

	function arm() {
		armed = true
		hold = new Promise<void>((resolve) => {
			releasePush = resolve
		})
		gate = new Promise<void>((resolve) => {
			notifyGate = resolve
		})
	}

	function release() {
		armed = false
		releasePush()
	}

	const remote: RemoteApi<Schema> = {
		connect: (api) => inner.connect(api),
		pull: (args) => inner.pull(args),
		push: async (args) => {
			if (armed) {
				notifyGate()
				await hold
			}
			return inner.push(args)
		},
	}

	return {
		remote,
		arm,
		release,
		waitForGate: () => gate,
	}
}

type DatabaseFixtures = {
	openDatabase: (options?: OpenDatabaseOptions) => Promise<DatabaseHandle>
	databaseHandle: DatabaseHandle
	database: TaskTandemDatabase
	makeClient: DatabaseHandle["makeClient"]
	makePushGate: () => ReturnType<typeof createGatedPushRemote<TaskSchema>>
}

export const test = base.extend<DatabaseFixtures>({
	openDatabase: async ({}, use) => {
		const handles: DatabaseHandle[] = []

		await use(async (options = {}) => {
			const handle = await createDatabaseHandle(options)
			handles.push(handle)
			return handle
		})

		for (const handle of handles) {
			await handle.close()
		}
		for (const dir of new Set(
			handles
				.map((handle) => handle.ownedDir)
				.filter((dir): dir is string => dir !== undefined),
		)) {
			await rm(dir, { recursive: true, force: true })
		}
	},

	databaseHandle: async ({ openDatabase }, use) => {
		await use(await openDatabase())
	},

	database: async ({ databaseHandle }, use) => {
		await use(databaseHandle.database)
	},

	makeClient: async ({ databaseHandle }, use) => {
		await use(databaseHandle.makeClient)
	},

	makePushGate: async ({ database }, use) => {
		const gates: ReturnType<typeof createGatedPushRemote<TaskSchema>>[] = []
		await use(() => {
			const gate = createGatedPushRemote(database)
			gates.push(gate)
			return gate
		})
		for (const gate of gates) {
			gate.release()
		}
	},
})
