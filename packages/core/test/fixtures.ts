import "fake-indexeddb/auto"

import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { expect as extendableExpect } from "extendable-expect"
import { expect as vitestExpect, test as base, vi, type Task } from "vitest"
import { TandemClient } from "../src/TandemClient"
import {
	collection,
	defineRelations,
	defineSchema,
	t,
} from "../src/schema/Schema"
import { TandemClientIndexedDbStorage } from "../src/storage/TandemClientIndexedDbStorage"
import { Logger } from "../src/utils/Logger"
import { JsonlLoggerSink } from "../src/utils/Logger.node"
import type { Codec } from "../src/utils/Codec"
import { TandemServer } from "@tanishqkancharla/tandem-server"
import type {
	AnySchema,
	RelationalQuery,
	RelationalQueryResult,
	RemoteApi,
	RngApi,
	AnyRelations,
	RuntimeSchemaDefinition,
	TandemClientStorageApi,
} from "@tanishqkancharla/tandem-core"
import { TestTandemServerStorage } from "./TandemServerStorage.fixture"

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
	Relations extends AnyRelations<Schema>,
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

export type ThreadClient = TandemClient<
	ThreadTestSchema,
	typeof threadTestRelations
>

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

function isTandemClientStorageApi<Schema extends AnySchema>(
	value: object,
): value is TandemClientStorageApi<Schema> {
	return (
		"commit" in value &&
		typeof (value as TandemClientStorageApi<Schema>).commit === "function"
	)
}

export type MakeStorageOptions<Schema extends AnySchema = AnySchema> = {
	dbName?: string
	schema?: RuntimeSchemaDefinition<Schema>
	codecs?: Record<string, Codec<any, any>>
}

export type MakeClientOptions<
	Schema extends AnySchema = TestsSchema,
	Relations extends AnyRelations<Schema> = AnyRelations<Schema>,
> = {
	label?: string
	schema?: RuntimeSchemaDefinition<Schema>
	relations?: Relations
	remote?: RemoteApi<Schema> | false
	clientStorage?: TandemClientStorageApi<Schema> | MakeStorageOptions<Schema>
	autoConnect?: boolean
	syncInterval?: number
}

export type MakeRemote = {
	(): TandemServer<TestsSchema, {}>
	<Schema extends AnySchema, Relations extends AnyRelations<Schema>>(options: {
		schema: RuntimeSchemaDefinition<Schema>
		relations: Relations
	}): TandemServer<Schema, Relations>
}

export type MakeStorage = {
	<Schema extends AnySchema = TestsSchema>(
		options?: MakeStorageOptions<Schema>,
	): TandemClientIndexedDbStorage<Schema>
}

export type MakeClient = {
	(
		options?: MakeClientOptions<TestsSchema, AnyRelations<TestsSchema>>,
	): Promise<TandemClient<TestsSchema, AnyRelations<TestsSchema>>>
	withSchema<
		Schema extends AnySchema = TestsSchema,
		Relations extends AnyRelations<Schema> = AnyRelations<Schema>,
	>(
		options: MakeClientOptions<Schema, Relations> & {
			remote: RemoteApi<Schema> | false
			relations: Relations
		},
	): Promise<TandemClient<Schema, Relations>>
}

type ThreadClients = {
	client1: ThreadClient
	client2: ThreadClient
}

type Fixtures = {
	logger: Logger
	rng: DemoRng
	server: TandemServer<TestsSchema, {}>
	makeRemote: MakeRemote
	makeStorage: MakeStorage
	makeClient: MakeClient
	client1: TandemClient<TestsSchema>
	client2: TandemClient<TestsSchema>
	threadClient: ThreadClient
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

	makeRemote: async ({}, use) => {
		const remotes: { close(): Promise<void> }[] = []

		function makeRemote(): TandemServer<TestsSchema, {}>
		function makeRemote<
			Schema extends AnySchema,
			Relations extends AnyRelations<Schema>,
		>(options: {
			schema: RuntimeSchemaDefinition<Schema>
			relations: Relations
		}): TandemServer<Schema, Relations>
		function makeRemote<
			Schema extends AnySchema,
			Relations extends AnyRelations<Schema>,
		>(options?: {
			schema: RuntimeSchemaDefinition<Schema>
			relations: Relations
		}) {
			if (options) {
				const remote = new TandemServer({
					...options,
					storage: new TestTandemServerStorage<Schema>(),
				})
				remotes.push(remote)
				return remote
			}

			const remote = new TandemServer({
				schema: testsRuntimeSchema,
				relations: {},
				storage: new TestTandemServerStorage<TestsSchema>(),
			})
			remotes.push(remote)
			return remote
		}

		await use(makeRemote)

		await Promise.all(remotes.map((remote) => remote.close()))
	},

	server: async ({ makeRemote }, use) => {
		await use(makeRemote())
	},

	makeStorage: async ({ rng }, use) => {
		const storages: {
			dbName: string
			storage: TandemClientIndexedDbStorage<any>
		}[] = []

		const makeStorage = <Schema extends AnySchema = TestsSchema>(
			options: MakeStorageOptions<Schema> = {},
		) => {
			const dbName = options.dbName ?? rng.next("storage")
			const storage = new TandemClientIndexedDbStorage<Schema>({
				dbName,
				schema: options.schema,
				codecs: options.codecs,
			})
			storages.push({ dbName, storage })
			return storage
		}

		await use(makeStorage as MakeStorage)

		for (const { storage } of storages) {
			await storage.close()
		}

		for (const dbName of new Set(storages.map(({ dbName }) => dbName))) {
			const storage = new TandemClientIndexedDbStorage<any>({ dbName })
			await storage.clear()
			await storage.close()
		}
	},

	makeClient: async ({ logger, rng, server, makeStorage }, use) => {
		const clients: {
			client: { disconnect(): Promise<void> }
			hasRemote: boolean
		}[] = []

		const createClient = async <
			Schema extends AnySchema,
			Relations extends AnyRelations<Schema>,
		>(
			options: MakeClientOptions<Schema, Relations>,
			fallbackRemote?: RemoteApi<Schema>,
		) => {
			const {
				autoConnect = false,
				label = "client",
				remote,
				schema,
				relations,
				clientStorage: storageOption,
				syncInterval = 0,
			} = options

			const resolvedRemote =
				remote === false ? undefined : (remote ?? fallbackRemote)

			const clientStorage = storageOption
				? isTandemClientStorageApi<Schema>(storageOption)
					? storageOption
					: makeStorage<Schema>({
							dbName: storageOption.dbName,
							schema: storageOption.schema ?? schema,
							codecs: storageOption.codecs,
						})
				: undefined

			const client = new TandemClient<Schema, Relations>({
				autoConnect,
				logger,
				rng: rng.create(label),
				remote: resolvedRemote,
				schema,
				relations,
				clientStorage,
				syncInterval,
			})

			clients.push({ client, hasRemote: Boolean(resolvedRemote) })
			await client.ready

			return client
		}

		const makeClient = Object.assign(
			(
				options: MakeClientOptions<TestsSchema, AnyRelations<TestsSchema>> = {},
			) => createClient(options, server),
			{
				withSchema: <
					Schema extends AnySchema = TestsSchema,
					Relations extends AnyRelations<Schema> = AnyRelations<Schema>,
				>(
					options: MakeClientOptions<Schema, Relations> & {
						remote: RemoteApi<Schema> | false
						relations: Relations
					},
				) => createClient(options),
			},
		)

		await use(makeClient)

		for (const { client, hasRemote } of clients) {
			if (hasRemote) {
				await client.disconnect()
			}
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

	threadClient: async ({ makeClient }, use) => {
		await use(
			await makeClient.withSchema({
				label: "thread-client",
				schema: threadTestSchema,
				relations: threadTestRelations,
				remote: false,
			}),
		)
	},

	threadClients: async ({ makeClient, makeRemote }, use) => {
		const remote = makeRemote({
			schema: threadTestSchema,
			relations: threadTestRelations,
		})
		const [client1, client2] = await Promise.all([
			makeClient.withSchema({
				label: "thread-client1",
				schema: threadTestSchema,
				relations: threadTestRelations,
				remote,
			}),
			makeClient.withSchema({
				label: "thread-client2",
				schema: threadTestSchema,
				relations: threadTestRelations,
				remote,
			}),
		])

		await Promise.all([client1.connect(), client2.connect()])
		await use({ client1, client2 })
	},
})
