import {
	collection,
	defineSchema,
	type LoggerApi,
	type RemoteApi,
	TandemClient,
} from "@tanishqkancharla/tandem-core"
import * as errore from "errore"
import { describe } from "vitest"
import {
	buildGatekeeperHarness,
	expectQuery,
	test,
	type DemoRng,
} from "../fixtures.js"

type Entry = {
	id: readonly [sessionId: string, sequence: number]
	body: string
}

type CompoundIdSchema = {
	entries: Entry
}

const schema = defineSchema({
	entries: collection<Entry>({ fields: ["id", "body"] }),
})

function createCompoundIdGatekeeper({
	server,
	logger,
	rng,
}: {
	server: RemoteApi<CompoundIdSchema>
	logger: LoggerApi
	rng: DemoRng
}) {
	const clients: TandemClient<CompoundIdSchema>[] = []
	const gatekeeper = buildGatekeeperHarness({
		server,
		createClient: (remote, label) => {
			const client = new TandemClient<CompoundIdSchema>({
				remote,
				schema,
				logger,
				rng: rng.create(label),
				autoConnect: false,
				syncInterval: 0,
			})
			clients.push(client)
			return client
		},
	})
	return { clients, gatekeeper }
}

const compoundIdTest = test.extend<{
	compoundIdGatekeeper: ReturnType<
		typeof createCompoundIdGatekeeper
	>["gatekeeper"]
}>({
	compoundIdGatekeeper: async ({ makeRemote, logger, rng }, use) => {
		const server = makeRemote({ schema, relations: {} })
		const { clients, gatekeeper } = createCompoundIdGatekeeper({
			server,
			logger,
			rng,
		})
		await using cleanup = new errore.AsyncDisposableStack()
		await using harness = gatekeeper

		for (const client of clients) {
			await client.ready
			await client.connect()
			cleanup.defer(() => client.disconnect())
		}

		await use(harness)
		await harness.deactivateGatesAndSettle()
	},
})

describe("TandemClient compound ID sync", () => {
	compoundIdTest(
		"syncs updates and removals for compound-ID records between clients",
		async ({ compoundIdGatekeeper }) => {
			const { client1, client2 } = compoundIdGatekeeper
			const subscription = client2.subscribe({ collection: "entries" })

			// Compound tuple IDs survive the client-server-client sync boundary
			const seedTx = client1.transact()
			seedTx.set("entries", {
				id: ["session-1", 1],
				body: "First entry",
			})
			seedTx.set("entries", {
				id: ["session-2", 1],
				body: "Other session",
			})
			await (
				await client1.commit(seedTx)
			).result

			await expectQuery(client2, { collection: "entries" }).toResolveTo([
				{ id: ["session-1", 1], body: "First entry" },
				{ id: ["session-2", 1], body: "Other session" },
			])

			// Exact compound IDs continue to address updates and removals remotely
			const editTx = client1.transact()
			editTx.set("entries", {
				id: ["session-1", 1],
				body: "Updated entry",
			})
			editTx.remove("entries", ["session-2", 1])
			await (
				await client1.commit(editTx)
			).result

			await expectQuery(client2, { collection: "entries" }).toResolveTo([
				{ id: ["session-1", 1], body: "Updated entry" },
			])
			subscription.destroy()
		},
	)
})
