import {
	type RemoteApi,
	type ScanWindow,
	TandemClient,
} from "@tanishqkancharla/tandem-core"
import * as errore from "errore"
import { describe, expect, vi } from "vitest"
import {
	buildGatekeeperHarness,
	expectQuery,
	test,
	todo,
	type TestsSchema,
} from "../fixtures.js"

/** Holds requests of one kind until released, so a test can act while they are in flight. */
class RequestHold {
	private held?: PromiseWithResolvers<void>

	hold() {
		this.held = Promise.withResolvers()
	}

	release() {
		this.held?.resolve()
		this.held = undefined
	}

	wait() {
		return this.held?.promise ?? Promise.resolve()
	}
}

const windowTest = test.extend<{
	pulls: ScanWindow<TestsSchema>[]
	pullHold: RequestHold
	failedPushes: { enabled: boolean }
	windowGatekeeper: ReturnType<
		typeof buildGatekeeperHarness<TestsSchema, TandemClient<TestsSchema>>
	>
}>({
	pulls: async ({}, use) => {
		await use([])
	},
	pullHold: async ({}, use) => {
		await use(new RequestHold())
	},
	failedPushes: async ({}, use) => {
		await use({ enabled: false })
	},
	windowGatekeeper: async (
		{ server, logger, rng, pulls, pullHold, failedPushes },
		use,
	) => {
		// Records the window each of client2's pulls sends.
		const remote: RemoteApi<TestsSchema> = {
			connect: (client) => server.connect(client),
			pull: async (args) => {
				if (args.clientId.startsWith("client2")) {
					pulls.push(args.scanWindow)
					await pullHold.wait()
				}
				return server.pull(args)
			},
			push: (args) =>
				failedPushes.enabled
					? Promise.resolve({ error: "unavailable", message: "offline" })
					: server.push(args),
		}
		const clients: TandemClient<TestsSchema>[] = []
		await using cleanup = new errore.AsyncDisposableStack()
		await using gatekeeper = buildGatekeeperHarness({
			server: remote,
			createClient: (transport, label) => {
				const client = new TandemClient<TestsSchema>({
					remote: transport,
					logger,
					rng: rng.create(label),
					autoConnect: false,
					syncInterval: 0,
				})
				clients.push(client)
				cleanup.defer(() => client.disconnect())
				return client
			},
		})
		for (const client of clients) {
			await client.ready
			await client.connect()
		}
		await use(gatekeeper)
		pullHold.release()
		await gatekeeper.deactivateGatesAndSettle()
	},
})

const open = { collection: "todos", where: { done: false } } as const
const done = { collection: "todos", where: { done: true } } as const
const encodedOpen = { collection: "todos", where: [["done", "=", false]] }
const encodedDone = { collection: "todos", where: [["done", "=", true]] }

describe("subscription lifecycle", () => {
	windowTest(
		"changing a page's query pulls the new window without the old rows",
		async ({ windowGatekeeper, pulls }) => {
			const { client1, client2 } = windowGatekeeper
			const seedTx = client1.transact()
			seedTx.set("todos", todo("open-1"))
			seedTx.set("todos", todo("done-1", { done: true }))
			await (
				await client1.commit(seedTx)
			).result

			const openPage = client2.subscribe(open)
			await expectQuery(client2, { collection: "todos" }).toResolveTo([
				todo("open-1"),
			])

			// Switching the page replaces the server's view with the new query alone.
			openPage.destroy()
			const donePage = client2.subscribe(done)
			await expectQuery(client2, { collection: "todos" }).toResolveTo([
				todo("done-1", { done: true }),
			])
			expect(pulls.at(-1)).toEqual([encodedDone])
			donePage.destroy()
		},
	)

	windowTest(
		"destroying the last subscription pulls an empty window",
		async ({ windowGatekeeper, pulls }) => {
			const { client1, client2 } = windowGatekeeper
			const subscription = client2.subscribe({ collection: "todos" })
			const tx = client1.transact()
			tx.set("todos", todo("todo-1"))
			await (
				await client1.commit(tx)
			).result
			await expectQuery(client2, { collection: "todos" }).toResolveTo([
				todo("todo-1"),
			])
			// Settle the pull that confirms the live payload.
			await (
				await client2.pullFromRemote()
			).result

			// No subscription remains, so the confirmed record leaves the replica.
			subscription.destroy()
			await expectQuery(client2, { collection: "todos" }).toResolveTo([])
			expect(pulls.at(-1)).toEqual([])
		},
	)

	windowTest(
		"an identical subscription survives another's destroy, even a repeated one",
		async ({ windowGatekeeper, pulls }) => {
			const { client1, client2 } = windowGatekeeper
			const tx = client1.transact()
			tx.set("todos", todo("open-1"))
			tx.set("todos", todo("done-1", { done: true }))
			await (
				await client1.commit(tx)
			).result
			const first = client2.subscribe(open)
			const second = client2.subscribe(open)
			const donePage = client2.subscribe(done)
			await expectQuery(client2, { collection: "todos" }).toResolveTo([
				todo("done-1", { done: true }),
				todo("open-1"),
			])

			// Destroying one copy twice leaves the other copy and the unrelated query.
			first.destroy()
			first.destroy()
			const pullCount = pulls.length
			await vi.waitFor(() => expect(pulls.length).toBeGreaterThan(pullCount))
			await (
				await client2.pullFromRemote()
			).result
			expect(pulls.at(-1)).toEqual([encodedOpen, encodedDone])
			expect(client2.query({ collection: "todos" })).toEqual([
				todo("done-1", { done: true }),
				todo("open-1"),
			])

			// The last copy's destroy removes rows only that query matched.
			second.destroy()
			await expectQuery(client2, { collection: "todos" }).toResolveTo([
				todo("done-1", { done: true }),
			])
			expect(pulls.at(-1)).toEqual([encodedDone])
			donePage.destroy()
		},
	)

	windowTest(
		"a change during an in-flight pull reaches the server in the next pull",
		async ({ windowGatekeeper, pulls, pullHold }) => {
			const { client1, client2 } = windowGatekeeper
			const tx = client1.transact()
			tx.set("todos", todo("open-1"))
			tx.set("todos", todo("done-1", { done: true }))
			await (
				await client1.commit(tx)
			).result

			// The pull that carries the open query is still in flight.
			pullHold.hold()
			const openPage = client2.subscribe(open)
			await vi.waitFor(() => expect(pulls.at(-1)).toEqual([encodedOpen]))
			openPage.destroy()
			const donePage = client2.subscribe(done)
			pullHold.release()

			await expectQuery(client2, { collection: "todos" }).toResolveTo([
				todo("done-1", { done: true }),
			])
			expect(pulls.at(-1)).toEqual([encodedDone])
			donePage.destroy()
		},
	)

	windowTest(
		"pruning outside every subscription keeps pending writes",
		async ({ windowGatekeeper, failedPushes, server }) => {
			const { client1, client2 } = windowGatekeeper
			const subscription = client2.subscribe({ collection: "todos" })
			const seedTx = client1.transact()
			seedTx.set("todos", todo("confirmed"))
			await (
				await client1.commit(seedTx)
			).result
			await expectQuery(client2, { collection: "todos" }).toResolveTo([
				todo("confirmed"),
			])

			// client2's write fails to reach the server, so it stays pending.
			failedPushes.enabled = true
			const pendingTx = client2.transact()
			pendingTx.set("todos", todo("pending"))
			await expect((await client2.commit(pendingTx)).result).rejects.toThrow()
			failedPushes.enabled = false

			// The empty window removes the confirmed record but not the pending one.
			subscription.destroy()
			await expectQuery(client2, { collection: "todos" }).toResolveTo([
				todo("pending"),
			])

			// Once the server acknowledges it, the write leaves too: no query covers it.
			const nextTx = client2.transact()
			nextTx.set("todos", todo("next"))
			await (
				await client2.commit(nextTx)
			).result
			await expectQuery(client2, { collection: "todos" }).toResolveTo([])
			expect(await server.query({ collection: "todos" })).toEqual([
				todo("confirmed"),
				todo("next"),
				todo("pending"),
			])
		},
	)
})
