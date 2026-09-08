import type {
	AnySchema,
	LoggerApi,
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

export type OpenTursoFixtureOptions = {
	filePath?: string
	createTables?: boolean
}

export type TursoFixture = {
	filePath: string
	clientSchema: TaskClientSchema
	relations: TaskRelations
	database: TaskTandemDatabase
	connectClient: (options?: {
		label?: string
		remote?: RemoteApi<TaskSchema>
	}) => Promise<TaskTandemClient>
	close: () => Promise<void>
}

export async function openTursoFixture(
	options: OpenTursoFixtureOptions = {},
): Promise<TursoFixture> {
	const createTables = options.createTables ?? true
	const ownedDir = options.filePath
		? undefined
		: await mkdtemp(join(tmpdir(), "tandem-turso-"))
	const filePath = options.filePath ?? join(ownedDir!, "tandem.db")
	const client = await connect(filePath)
	try {
		if (createTables) {
			await client.exec(taskSqlSchema)
		}

		const db = createTursoDrizzle(client)
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

		const connectedClients: TaskTandemClient[] = []
		let clientCount = 0

		return {
			filePath,
			clientSchema,
			relations,
			database,
			async connectClient(connectOptions = {}) {
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
				connectedClients.push(tandemClient)
				return tandemClient
			},
			async close() {
				for (const tandemClient of connectedClients) {
					await tandemClient.disconnect()
				}
				await database.destroy()
				await client.close()
				if (ownedDir) {
					await rm(ownedDir, { recursive: true, force: true })
				}
			},
		}
	} catch (error) {
		await client.close()
		if (ownedDir) {
			await rm(ownedDir, { recursive: true, force: true })
		}
		throw error
	}
}

export function createGatedPushRemote<Schema extends AnySchema>(
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
