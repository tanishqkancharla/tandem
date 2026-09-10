import { Gatekeeper } from "@tanishqkancharla/gatekeeper"
import asyncHooks from "node:async_hooks"
import * as errore from "errore"
import { TandemClient } from "../../src/TandemClient"
import type { Transaction } from "../../src/transaction/Transaction"
import type { RemoteApi } from "../../src/sync/SyncEngine"
import { test as base, testsRuntimeSchema, type TestsSchema } from "../fixtures"

// A fixed todo query keeps the scenario API small without changing Tandem's
// real transaction, sync queue, subscriptions, or conflict resolution behavior.
class TodoClient {
	constructor(private readonly client: TandemClient<TestsSchema>) {}
	transact() {
		return this.client.transact()
	}
	commit(tx: Transaction<TestsSchema>) {
		return this.client.commit(tx)
	}
	pullFromRemote() {
		return this.client.pullFromRemote()
	}
	todos() {
		return this.client.query({ collection: "todos" })
	}
}

// In-process notifications need the same context boundary a network transport
// supplies: a poke runs in the receiving client's context, not the writer's.
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

function buildHarness(
	server: RemoteApi<TestsSchema>,
	createClient: (remote: RemoteApi<TestsSchema>, label: string) => TodoClient,
) {
	return new Gatekeeper()
		.add("server", () => new InProcessTransport(server))
		.add("client1", ({ server }) => createClient(server, "client1"))
		.add("client2", ({ server }) => createClient(server, "client2"))
		.build()
}

export const test = base.extend<{
	gatekeeper: ReturnType<typeof buildHarness>
}>({
	gatekeeper: async ({ server, logger, rng }, use) => {
		const clients: TandemClient<TestsSchema>[] = []
		await using cleanup = new errore.AsyncDisposableStack()
		await using gatekeeper = buildHarness(server, (remote, label) => {
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
			return new TodoClient(client)
		})

		for (const client of clients) {
			await client.ready
			const subscription = client.subscribe({ collection: "todos" })
			cleanup.defer(() => subscription.destroy())
			await client.connect()
		}
		await use(gatekeeper)
	},
})
