import "fake-indexeddb/auto"

import { Gatekeeper } from "@tanishqkancharla/gatekeeper"
import {
	type AnyRelations,
	type AnySchema,
	collection,
	type Codec,
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
	type TimerApi,
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
>(client: Pick<TandemClient<Schema, Relations>, "query">, query: Query) {
	return expectResolver(
		() =>
			client.query(query) as RelationalQueryResult<Schema, Relations, Query>,
	)
}

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

export type MakeStorageOptions<Schema extends AnySchema = AnySchema> = {
	dbName?: string
	schema?: RuntimeSchemaDefinition<Schema>
	codecs?: Record<string, Codec<any, any>>
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

// A real transport creates a fresh async context when it delivers a poke. The
// in-process server needs the same boundary so one client's notification work
// is not attributed to another client's active Gatekeeper call.
class InProcessTransport<
	Schema extends AnySchema,
> implements RemoteApi<Schema> {
	constructor(private readonly server: RemoteApi<Schema>) {}

	connect: RemoteApi<Schema>["connect"] = (client) =>
		this.server.connect({
			...client,
			poke: asyncHooks.AsyncResource.bind(client.poke),
		})
	push: RemoteApi<Schema>["push"] = (args) => this.server.push(args)
	pull: RemoteApi<Schema>["pull"] = (args) => this.server.pull(args)
}

class TestTimer implements TimerApi {
	waitForNextTick(): Promise<void> {
		return Promise.resolve()
	}
}

export function buildGatekeeperHarness<
	Schema extends AnySchema,
	Client extends object,
>({
	server,
	createClient,
}: {
	server: RemoteApi<Schema>
	createClient: (remote: RemoteApi<Schema>, label: string) => Client
}) {
	return new Gatekeeper()
		.add("server", () => new InProcessTransport(server))
		.add("client1", ({ server }) => createClient(server, "client1"))
		.add("client2", ({ server }) => createClient(server, "client2"))
		.build()
}

export function buildTimerGatekeeperHarness<
	Schema extends AnySchema,
	Client extends object,
>({
	server,
	createClient,
}: {
	server: RemoteApi<Schema>
	createClient: (
		remote: RemoteApi<Schema>,
		label: string,
		timer: TimerApi,
	) => Client
}) {
	return new Gatekeeper()
		.add("server", () => new InProcessTransport(server))
		.add("client1Timer", () => new TestTimer(), {
			gates: { enter: false, exit: true },
		})
		.add("client2Timer", () => new TestTimer(), {
			gates: { enter: false, exit: true },
		})
		.add("client1", ({ server, client1Timer }) =>
			createClient(server, "client1", client1Timer),
		)
		.add("client2", ({ server, client2Timer }) =>
			createClient(server, "client2", client2Timer),
		)
		.build()
}

function buildDefaultGatekeeperHarness(
	server: RemoteApi<TestsSchema>,
	createClient: (
		remote: RemoteApi<TestsSchema>,
		label: string,
	) => TandemClient<TestsSchema>,
) {
	return buildGatekeeperHarness({ server, createClient })
}

type GatekeeperHarness = ReturnType<typeof buildDefaultGatekeeperHarness>

type Fixtures = {
	logger: Logger
	rng: DemoRng
	server: TandemServer<TestsSchema, {}>
	makeRemote: MakeRemote
	makeStorage: MakeStorage
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

	gatekeeper: async ({ server, logger, rng }, use) => {
		const clients: TandemClient<TestsSchema>[] = []
		await using cleanup = new errore.AsyncDisposableStack()
		await using gatekeeper = buildDefaultGatekeeperHarness(
			server,
			(remote, label) => {
				const client = new TandemClient<TestsSchema>({
					remote,
					logger,
					rng: rng.create(label),
					autoConnect: false,
					syncInterval: 0,
				})
				clients.push(client)
				cleanup.defer(() => client.disconnect())
				return client
			},
		)

		for (const client of clients) {
			await client.ready
			await client.connect()
		}

		await use(gatekeeper)
		await gatekeeper.deactivateGatesAndSettle()
	},
})
