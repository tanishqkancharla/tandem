import "fake-indexeddb/auto"

import { Gatekeeper } from "@tanishqkancharla/gatekeeper"
import {
	type AnyRelations,
	type AnySchema,
	collection,
	type Codec,
	defineRelations,
	defineSchema,
	Logger,
	type RelationalQuery,
	type RelationalQueryResult,
	type RemoteApi,
	type RngApi,
	type RuntimeSchemaDefinition,
	t,
	TandemClient,
	TandemClientIndexedDbStorage,
	type TandemClientStorageApi,
} from "@tanishqkancharla/tandem-core"
import {
	TandemServer,
	type TandemServerStorageApi,
	type TandemTuple,
} from "@tanishqkancharla/tandem-server"
import asyncHooks from "node:async_hooks"
import { expect as extendableExpect } from "extendable-expect"
import * as errore from "errore"
import {
	InMemoryTupleStorage,
	type ScanStorageArgs,
	type WriteOps,
} from "tuple-database"
import { expect as vitestExpect, test as base, vi } from "vitest"

class TestTandemServerStorage<
	Schema extends AnySchema,
> implements TandemServerStorageApi<Schema> {
	private readonly memory = new InMemoryTupleStorage()

	scan(args?: ScanStorageArgs): Promise<TandemTuple<Schema>[]> {
		return Promise.resolve(this.memory.scan(args) as TandemTuple<Schema>[])
	}

	commit(writes: WriteOps<TandemTuple<Schema>>): Promise<void> {
		this.memory.commit(writes)
		return Promise.resolve()
	}

	close(): Promise<void> {
		this.memory.close()
		return Promise.resolve()
	}
}

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

// A real transport creates a fresh async context when it delivers a poke. The
// in-process server needs the same boundary so one client's notification work
// is not attributed to another client's active Gatekeeper call.
class InProcessTransport implements RemoteApi<TestsSchema> {
	constructor(private readonly server: RemoteApi<TestsSchema>) {}

	connect: RemoteApi<TestsSchema>["connect"] = (client) =>
		this.server.connect({
			...client,
			poke: asyncHooks.AsyncResource.bind(client.poke),
		})
	push: RemoteApi<TestsSchema>["push"] = (args) => this.server.push(args)
	pull: RemoteApi<TestsSchema>["pull"] = (args) => this.server.pull(args)
}

function buildGatekeeperHarness(
	server: RemoteApi<TestsSchema>,
	createClient: (
		remote: RemoteApi<TestsSchema>,
		label: string,
	) => TandemClient<TestsSchema>,
) {
	return new Gatekeeper()
		.add("server", () => new InProcessTransport(server))
		.add("client1", ({ server }) => createClient(server, "client1"))
		.add("client2", ({ server }) => createClient(server, "client2"))
		.build()
}

type GatekeeperHarness = ReturnType<typeof buildGatekeeperHarness>

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
	gatekeeper: GatekeeperHarness
}

export const test = base.extend<Fixtures>({
	logger: async ({}, use) => {
		await use(new Logger({ sinks: [] }))
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

	gatekeeper: async ({ server, logger, rng }, use) => {
		const clients: TandemClient<TestsSchema>[] = []
		await using cleanup = new errore.AsyncDisposableStack()
		await using gatekeeper = buildGatekeeperHarness(server, (remote, label) => {
			const client = new TandemClient<TestsSchema>({
				remote,
				schema: testsRuntimeSchema,
				logger,
				rng: rng.create(label),
				autoConnect: false,
				syncInterval: 0,
			})
			clients.push(client)
			cleanup.defer(() => client.disconnect())
			return client
		})

		for (const client of clients) {
			await client.ready
			const subscription = client.subscribe({ collection: "todos" })
			cleanup.defer(() => subscription.destroy())
			await client.connect()
		}

		await use(gatekeeper)
		await gatekeeper.deactivateGatesAndSettle()
	},
})
