import "fake-indexeddb/auto"

import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { expect as extendableExpect } from "extendable-expect"
import { expect as vitestExpect, test as base, vi } from "vitest"
import { TandemClient } from "../src/TandemClient"
import {
	collection,
	defineRelations,
	defineSchema,
	t,
} from "../src/schema/Schema"
import { IndexedDbTupleStorage } from "../src/storage/IndexedDbAdapter"
import { Logger } from "../src/utils/Logger"
import { JsonlLoggerSink } from "../src/utils/JsonlLoggerSink"
import { InMemoryRemote } from "../packages/server/src/index"
import type {
	AnySchema,
	RelationalQuery,
	RelationalQueryResult,
	RemoteApi,
	RngApi,
	RuntimeRelationsDefinition,
	RuntimeSchemaDefinition,
} from "../src/types"
import type { Task } from "vitest"

export type TestsTodo = {
	id: string
	text: string
	done: boolean
	priority: number
}

export type TestsSchema = {
	todos: TestsTodo
}

export const testsRuntimeSchema = defineSchema({
	todos: collection({
		id: t.id(),
		text: t.string(),
		done: t.boolean(),
		priority: t.number(),
	}),
}) satisfies RuntimeSchemaDefinition<TestsSchema>

export function todo(
	id: string,
	overrides: Partial<TestsTodo> = {},
): TestsTodo {
	return {
		id,
		text: `Todo ${id}`,
		done: false,
		priority: 1,
		...overrides,
	}
}

const expectResolver = extendableExpect.extend({
	async toResolveTo<Result>(resolve: () => Result, expected: Result) {
		await vi.waitFor(() => {
			vitestExpect(resolve()).toEqual(expected)
		})
	},
})

export function expectQuery<
	Schema extends AnySchema,
	Relations extends RuntimeRelationsDefinition<Schema>,
	Query extends RelationalQuery<Schema, Relations>,
>(client: TandemClient<Schema, Relations>, query: Query) {
	return expectResolver(
		() =>
			client.query(query) as RelationalQueryResult<Schema, Relations, Query>,
	)
}

export type ThreadTestUser = {
	id: string
	profileId: string
	name: string
}

export type ThreadTestProfile = {
	id: string
	displayName: string
}

export type ThreadTestThread = {
	id: string
	ownerId: string
	title: string
	status: "active" | "archived"
}

export type ThreadTestMessage = {
	id: string
	threadId: string
	body: string
	createdAt: number
}

export type ThreadTestSchema = {
	users: ThreadTestUser
	profiles: ThreadTestProfile
	threads: ThreadTestThread
	messages: ThreadTestMessage
}

export const threadTestSchema = defineSchema({
	users: collection<ThreadTestUser>({ fields: ["id", "profileId", "name"] }),
	profiles: collection<ThreadTestProfile>({ fields: ["id", "displayName"] }),
	threads: collection<ThreadTestThread>({
		fields: ["id", "ownerId", "title", "status"],
	}),
	messages: collection<ThreadTestMessage>({
		fields: ["id", "threadId", "body", "createdAt"],
	}),
})

export const threadTestRelations = defineRelations(
	threadTestSchema,
	({ one, many }) => ({
		users: {
			profile: one("profiles", { from: "profileId", to: "id" }),
		},
		threads: {
			owner: one("users", { from: "ownerId", to: "id" }),
			messages: many("messages", { from: "id", to: "threadId" }),
		},
	}),
)

export type DemoRng = {
	next(prefix?: string): string
	create(prefix?: string): RngApi
}

function sanitizePathSegment(value: string): string {
	return value
		.replace(/[^a-zA-Z0-9.-]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.toLowerCase()
}

function getTestLogFilePath(task: Readonly<Task>): string {
	const names: string[] = [task.name]
	let currentSuite = task.suite

	while (currentSuite) {
		names.unshift(currentSuite.name)
		currentSuite = currentSuite.suite
	}

	const fileName = `${names.map(sanitizePathSegment).join("__")}.jsonl`
	return resolve(process.cwd(), "test", "logs", fileName)
}

function createRng(): DemoRng {
	let counter = 0

	return {
		next(prefix = "id") {
			counter += 1
			return `${prefix}-${counter}`
		},
		create(prefix = "id") {
			return {
				randomId: () => {
					counter += 1
					return `${prefix}-${counter}`
				},
			}
		},
	}
}

type ClientOptions = {
	label?: string
	schema?: RuntimeSchemaDefinition<TestsSchema>
	remote?: RemoteApi<TestsSchema> | false
	storageDbName?: string
	syncInterval?: number
	autoConnect?: boolean
}

type Fixtures = {
	logger: Logger
	rng: DemoRng
	server: InMemoryRemote<TestsSchema>
	client1: TandemClient<TestsSchema>
	client2: TandemClient<TestsSchema>
	makeClient: (options?: ClientOptions) => Promise<TandemClient<TestsSchema>>
}

type ThreadClients = {
	client1: TandemClient<ThreadTestSchema, typeof threadTestRelations>
	client2: TandemClient<ThreadTestSchema, typeof threadTestRelations>
}

type TandemClientFixtures = {
	threadClients: ThreadClients
}

export const test = base.extend<Fixtures>({
	logger: async ({ task, onTestFinished }, use) => {
		const logFilePath = getTestLogFilePath(task)
		mkdirSync(dirname(logFilePath), { recursive: true })
		writeFileSync(logFilePath, "")

		onTestFinished((result) => {
			if (result.state === "fail") {
				const logContents = readFileSync(logFilePath, "utf8")
				console.error(`\n--- Tandem test logs: ${task.name} ---`)
				console.error(`log file: ${logFilePath}`)
				console.error(logContents || "(no logs captured)")
				console.error("--- End Tandem test logs ---\n")
				return
			}

			rmSync(logFilePath, { force: true })
		})

		await use(
			new Logger({ sinks: new JsonlLoggerSink({ filePath: logFilePath }) }),
		)
	},

	rng: async ({}, use) => {
		await use(createRng())
	},

	server: async ({}, use) => {
		await use(new InMemoryRemote<TestsSchema>())
	},

	makeClient: async ({ logger, rng, server }, use) => {
		const clients: { client: TandemClient<TestsSchema>; hasRemote: boolean }[] =
			[]
		const storages: {
			dbName: string
			storage: IndexedDbTupleStorage<TestsSchema>
		}[] = []

		await use(async (options = {}) => {
			const {
				autoConnect = false,
				label = "client",
				remote,
				schema,
				storageDbName,
				syncInterval = 0,
			} = options

			const resolvedRemote = remote === undefined ? server : remote || undefined
			const storage = storageDbName
				? new IndexedDbTupleStorage<TestsSchema>({ dbName: storageDbName })
				: undefined

			if (storage && storageDbName) {
				storages.push({ dbName: storageDbName, storage })
			}

			const client = new TandemClient<TestsSchema>({
				autoConnect,
				logger,
				rng: rng.create(label),
				remote: resolvedRemote,
				schema,
				storage,
				syncInterval,
			})

			clients.push({ client, hasRemote: Boolean(resolvedRemote) })
			await client.ready

			return client
		})

		for (const { client, hasRemote } of clients) {
			if (hasRemote) {
				await client.disconnect()
			}
		}

		for (const { storage } of storages) {
			await storage.close()
		}

		for (const dbName of new Set(storages.map(({ dbName }) => dbName))) {
			const storage = new IndexedDbTupleStorage<TestsSchema>({ dbName })
			await storage.clear()
		}
	},

	client1: async ({ makeClient }, use) => {
		const client = await makeClient({ label: "client1" })
		await client.connect()
		await use(client)
	},

	client2: async ({ makeClient }, use) => {
		const client = await makeClient({ label: "client2" })
		await client.connect()
		await use(client)
	},
})

export const tandemClientTest = test.extend<TandemClientFixtures>({
	threadClients: async ({ logger, rng }, use) => {
		const server = new InMemoryRemote<ThreadTestSchema>()
		const client1 = new TandemClient<
			ThreadTestSchema,
			typeof threadTestRelations
		>({
			schema: threadTestSchema,
			relations: threadTestRelations,
			remote: server,
			logger,
			rng: rng.create("thread-client1"),
			syncInterval: 0,
		})
		const client2 = new TandemClient<
			ThreadTestSchema,
			typeof threadTestRelations
		>({
			schema: threadTestSchema,
			relations: threadTestRelations,
			remote: server,
			logger,
			rng: rng.create("thread-client2"),
			syncInterval: 0,
		})

		await use({ client1, client2 })

		await Promise.all([client1.disconnect(), client2.disconnect()])
	},
})
