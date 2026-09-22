import {
	type LoggerApi,
	type RemoteApi,
	TandemClient,
} from "@tanishqkancharla/tandem-core"
import * as errore from "errore"
import { describe } from "vitest"
import {
	buildTimerGatekeeperHarness,
	test,
	todo,
	type DemoRng,
	type TestsSchema,
} from "../fixtures.js"

function createTimerGatekeeper({
	server,
	logger,
	rng,
}: {
	server: RemoteApi<TestsSchema>
	logger: LoggerApi
	rng: DemoRng
}) {
	const clients: TandemClient<TestsSchema>[] = []
	const gatekeeper = buildTimerGatekeeperHarness({
		server,
		createClient: (remote, label, timer) => {
			const client = new TandemClient<TestsSchema>({
				remote,
				logger,
				rng: rng.create(label),
				syncInterval: timer,
				autoConnect: false,
			})
			clients.push(client)
			return client
		},
	})
	return { clients, gatekeeper }
}

type TimerGatekeeper = ReturnType<typeof createTimerGatekeeper>["gatekeeper"]

const timerTest = test.extend<{ timerGatekeeper: TimerGatekeeper }>({
	timerGatekeeper: async ({ server, logger, rng }, use) => {
		const { clients, gatekeeper } = createTimerGatekeeper({
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

describe("TandemClient sync timers", () => {
	timerTest(
		"waits for its timer before pushing a commit",
		async ({ timerGatekeeper }) => {
			const { client1 } = timerGatekeeper
			await timerGatekeeper.activateGates()
			const tx = client1.transact()
			tx.set("todos", todo("todo-1"))

			const commit = await client1.commit(tx)

			commit.assertSentBy("client1Timer").assertWaitingFor("client1")

			await commit.continueTo("client1")

			commit.assertSentBy("client1").assertWaitingFor("server")
		},
	)

	timerTest(
		"advances each client's timer independently",
		async ({ timerGatekeeper }) => {
			const { client1, client2 } = timerGatekeeper
			await timerGatekeeper.activateGates()
			const client1Tx = client1.transact()
			client1Tx.set("todos", todo("client1-todo"))
			const client2Tx = client2.transact()
			client2Tx.set("todos", todo("client2-todo"))
			const client1Commit = await client1.commit(client1Tx)
			const client2Commit = await client2.commit(client2Tx)

			await client1Commit.continueTo("client1")

			client1Commit.assertSentBy("client1").assertWaitingFor("server")
			client2Commit.assertSentBy("client2Timer").assertWaitingFor("client2")
		},
	)
})
