import {
	codec,
	collection,
	defineSchema,
	partialObject,
	string,
	type AnySchema,
	type ClientApi,
	type Mutation,
	type RemoteApi,
	type RuntimeSchemaDefinition,
	TandemClient,
	type TandemClientArgs,
	type TandemClientStorageApi,
	TandemClientIndexedDbStorage,
} from "@tanishqkancharla/tandem-core"
import {
	InMemoryTabs,
	type InMemoryTab,
} from "@tanishqkancharla/tandem-core/internal"
import { Gatekeeper } from "@tanishqkancharla/gatekeeper"
import * as errore from "errore"
import { describe, expect, vi } from "vitest"
import { test, todo, type TestsSchema } from "./fixtures.js"

type Tab<Schema extends AnySchema> = {
	client: TandemClient<Schema>
	/** Ends the tab mid-flight: no further storage, network, or channel I/O completes. */
	crash(): void
}

type OpenTabOptions<Schema extends AnySchema> = Pick<
	TandemClientArgs<Schema, {}>,
	"autoConnect" | "syncInterval"
> & {
	/** Runs after each storage commit completes, before the leader continues. */
	afterStorageCommit?: (
		writes: Parameters<TandemClientStorageApi<Schema>["commit"]>[0],
	) => void
	/** Returns the tab before its first pull from the leader has restored it. */
	awaitReady?: boolean
}

const never = () => new Promise<never>(() => {})

function createTabs<Schema extends AnySchema>({
	server,
	schema,
	dbName,
	makeStorage,
	logger,
	rng,
}: {
	server: RemoteApi<Schema>
	schema?: RuntimeSchemaDefinition<Schema>
	dbName: string
	makeStorage: (options: {
		dbName: string
		schema?: RuntimeSchemaDefinition<Schema>
	}) => TandemClientIndexedDbStorage<Schema>
	logger: TandemClientArgs<Schema, {}>["logger"]
	rng: { create(prefix: string): { randomId(): string } }
}) {
	const browser = new InMemoryTabs()
	const opened: { client: TandemClient<Schema>; tab: InMemoryTab }[] = []
	/** Every mutation the server received, by sender. */
	const pushed: { clientId: string; mutation: Mutation<Schema> }[] = []
	/** The scan window of every pull the server received. */
	const pulls: { tab: string; scanWindow: unknown[] }[] = []
	/** Remote faults shared by every tab. */
	const remote = {
		down: false,
		pushHangs: false,
		connectDelayMs: 0,
		/** Pushes that reached the remote while it was stalled. */
		stalledPushes: 0,
		failedPushes: 0,
		pushBarrier: undefined as Promise<void> | undefined,
		connectBarrier: undefined as Promise<void> | undefined,
		pullBarrier: undefined as Promise<void> | undefined,
		responseBarrier: undefined as Promise<void> | undefined,
		connecting: 0,
		disconnected: 0,
		delayViews: false,
	}
	/** Storage faults shared by every tab. */
	const storageFaults = {
		/** How many storage commits carrying `failingKey` fail before writing. */
		failedWrites: 0,
		failingKey: "tab-write" as "tab-write" | "session",
	}
	const heldViews: (() => void)[] = []
	const unavailable = {
		error: "unavailable",
		message: "Remote is down",
	} as const

	async function open(
		label: string,
		{
			afterStorageCommit,
			awaitReady = true,
			...options
		}: OpenTabOptions<Schema> = {},
	): Promise<Tab<Schema>> {
		const tab = browser.openTab()
		let alive = true
		const storage = makeStorage({ dbName, schema })
		const tabStorage: TandemClientStorageApi<Schema> = {
			name: storage.name,
			get codecs() {
				return storage.codecs
			},
			scan: (args) => (alive ? storage.scan(args) : never()),
			commit: async (writes) => {
				if (!alive) return never()
				if (
					storageFaults.failedWrites > 0 &&
					writes.set?.some(({ key }) => key[0] === storageFaults.failingKey)
				) {
					storageFaults.failedWrites -= 1
					throw new Error("Storage is full")
				}
				await storage.commit(writes)
				afterStorageCommit?.(writes)
			},
			clear: () => (alive ? storage.clear() : never()),
			close: () => storage.close(),
		}
		const network: RemoteApi<Schema> = {
			connect: async (api: ClientApi) => {
				if (!alive) return never()
				if (remote.down) return unavailable
				remote.connecting++
				await remote.connectBarrier
				if (remote.connectDelayMs)
					await new Promise((resolve) =>
						setTimeout(resolve, remote.connectDelayMs),
					)
				const connected = await server.connect({
					...api,
					poke: () => (alive ? api.poke() : Promise.resolve()),
				})
				if (typeof connected !== "function") return connected
				return async () => {
					remote.disconnected++
					await connected()
				}
			},
			push: async (args) => {
				if (!alive) return never()
				await remote.pushBarrier
				if (remote.pushHangs) {
					remote.stalledPushes += 1
					return never()
				}
				if (remote.down) {
					remote.failedPushes += 1
					return unavailable
				}
				for (const mutation of args.mutations)
					pushed.push({ clientId: args.clientId, mutation })
				const result = await server.push(args)
				await remote.responseBarrier
				return result
			},
			pull: async (args) => {
				if (!alive) return never()
				if (remote.down) return unavailable
				await remote.pullBarrier
				pulls.push({ tab: label, scanWindow: args.scanWindow })
				return server.pull(args)
			},
		}
		const client = new TandemClient<Schema>({
			schema,
			remote: network,
			clientStorage: tabStorage,
			clientStorageWriteInterval: 0,
			syncInterval: 0,
			logger,
			rng: rng.create(label),
			tabs: {
				environment: {
					locks: tab.locks,
					openChannel(name) {
						const channel = tab.openChannel(name)
						return {
							postMessage(message) {
								const send = () => {
									if (alive) channel.postMessage(message)
								}
								if (
									remote.delayViews &&
									(message as { type: string }).type === "view"
								)
									heldViews.push(send)
								else send()
							},
							addEventListener: (type, listener) =>
								channel.addEventListener(type, listener),
							removeEventListener: (type, listener) =>
								channel.removeEventListener(type, listener),
							close: () => channel.close(),
						}
					},
				},
			},
			...options,
		})
		opened.push({ client, tab })
		if (awaitReady) await client.ready
		return {
			client,
			crash() {
				alive = false
				tab.close()
			},
		}
	}

	async function close() {
		for (const { client, tab } of opened.reverse()) {
			await Promise.race([
				client.close(),
				new Promise((resolve) => setTimeout(resolve, 100)),
			])
			tab.close()
		}
	}

	return {
		open,
		close,
		pushed,
		pulls,
		remote,
		storageFaults,
		heldViews,
		releaseViews(reverse = false) {
			const pending = heldViews.splice(0)
			for (const send of reverse ? pending.reverse() : pending) send()
		},
	}
}

const tabsTest = test.extend<{
	tabs: ReturnType<typeof createTabs<TestsSchema>>
}>({
	tabs: async ({ server, makeStorage, logger, rng }, use) => {
		const tabs = createTabs<TestsSchema>({
			server,
			dbName: rng.next("shared-storage"),
			makeStorage,
			logger,
			rng,
		})
		await use(tabs)
		await tabs.close()
	},
})

describe("TandemClient tabs", () => {
	tabsTest(
		"takeover cannot complete a saved commit before the replacement connects and pushes",
		async ({ tabs, server }) => {
			const first = await tabs.open("tab1")
			const second = await tabs.open("tab2")
			await using gatekeeper = new Gatekeeper()
				.add("client", () => second.client)
				.build()
			const { client } = gatekeeper
			client.subscribe({ collection: "todos" })
			await (
				await client.connect()
			).result
			tabs.remote.pushHangs = true
			const tx = client.transact()
			tx.set("todos", todo("handoff-pending"))
			const committed = client.commit(tx).then((call) => call.result)
			let complete = false
			void committed.then(() => {
				complete = true
			})
			await (
				await client.flushClientStorage()
			).result
			await expect.poll(() => tabs.remote.stalledPushes).toBeGreaterThan(0)

			// The replacement can restore and save locally while its remote connection is held.
			const connect = Promise.withResolvers<void>()
			tabs.remote.connectBarrier = connect.promise
			const attempts = tabs.remote.connecting
			tabs.remote.pushHangs = false
			first.crash()
			await expect.poll(() => tabs.remote.connecting).toBeGreaterThan(attempts)
			await (
				await client.flushClientStorage()
			).result
			expect(complete).toBe(false)
			expect(await server.query({ collection: "todos" })).toEqual([])

			// The surviving caller completes only after the replacement actually delivers its mutation.
			connect.resolve()
			await committed
			expect(await server.query({ collection: "todos" })).toEqual([
				todo("handoff-pending"),
			])
		},
	)

	tabsTest(
		"a lost server response across takeover does not overwrite a later server correction",
		async ({ tabs, server }) => {
			const first = await tabs.open("tab1")
			const second = await tabs.open("tab2")
			await using gatekeeper = new Gatekeeper()
				.add("client", () => second.client)
				.build()
			const { client } = gatekeeper
			client.subscribe({ collection: "todos" })
			await (
				await client.connect()
			).result
			tabs.remote.responseBarrier = never()
			const tx = client.transact()
			tx.set("todos", todo("accepted"))
			const committed = client.commit(tx).then((call) => call.result)
			await (
				await client.flushClientStorage()
			).result
			await expect
				.poll(() => server.query({ collection: "todos" }))
				.toEqual([todo("accepted")])

			// Reapplying the accepted set after takeover would erase this independent correction.
			const correctionTx = server.transact()
			await correctionTx.update("todos", "accepted", {
				text: "server correction",
			})
			await server.commit(correctionTx)
			tabs.remote.responseBarrier = undefined
			first.crash()
			await committed
			const expected = [todo("accepted", { text: "server correction" })]
			expect(await server.query({ collection: "todos" })).toEqual(expected)
			await expect
				.poll(() => client.query({ collection: "todos" }))
				.toEqual(expected)
		},
	)

	tabsTest(
		"older leader views cannot erase a newer pending edit or replace a newer view",
		async ({ tabs }) => {
			const first = await tabs.open("tab1", { autoConnect: false })
			const second = await tabs.open("tab2", { autoConnect: false })
			await using gatekeeper = new Gatekeeper()
				.add("client1", () => first.client)
				.add("client2", () => second.client)
				.build()
			const { client1, client2 } = gatekeeper
			client1.subscribe({ collection: "todos" })
			client2.subscribe({ collection: "todos" })
			const seedTx = client1.transact()
			seedTx.set("todos", todo("edited"))
			await (
				await client1.commit(seedTx)
			).result
			await expect
				.poll(() => client2.query({ collection: "todos" }))
				.toEqual([todo("edited")])

			// Hold an older view before making another edit in the receiving tab.
			tabs.remote.delayViews = true
			const otherTx = client1.transact()
			otherTx.update("todos", "edited", { text: "older leader view" })
			await (
				await client1.commit(otherTx)
			).result
			await expect.poll(() => tabs.heldViews.length).toBeGreaterThan(0)
			const localTx = client2.transact()
			localTx.update("todos", "edited", { text: "my newer edit" })
			const committed = client2.commit(localTx).then((call) => call.result)
			tabs.releaseViews()
			await committed
			expect(client2.query({ collection: "todos" })).toEqual([
				todo("edited", { text: "my newer edit" }),
			])

			// Deliver new and old snapshots in reverse order; both tabs retain the latest value.
			await expect.poll(() => tabs.heldViews.length).toBeGreaterThan(0)
			tabs.remote.delayViews = false
			tabs.releaseViews(true)
			await expect
				.poll(() => client1.query({ collection: "todos" }))
				.toEqual([todo("edited", { text: "my newer edit" })])
			expect(client2.query({ collection: "todos" })).toEqual([
				todo("edited", { text: "my newer edit" }),
			])
		},
	)

	tabsTest(
		"crashing the last tab requesting the server releases the shared connection",
		async ({ tabs }) => {
			await tabs.open("tab1", { autoConnect: false })
			const second = await tabs.open("tab2")
			await using gatekeeper = new Gatekeeper()
				.add("client", () => second.client)
				.build()
			await (
				await gatekeeper.client.connect()
			).result
			const disconnected = tabs.remote.disconnected
			second.crash()
			await expect
				.poll(() => tabs.remote.disconnected)
				.toBeGreaterThan(disconnected)
		},
	)

	tabsTest(
		"connected commits wait for the server while local saving and other tabs continue",
		async ({ tabs, server }) => {
			const first = await tabs.open("tab1")
			const second = await tabs.open("tab2")
			await using gatekeeper = new Gatekeeper()
				.add("client1", () => first.client)
				.add("client2", () => second.client)
				.build()
			const { client1, client2 } = gatekeeper
			client1.subscribe({ collection: "todos" })
			client2.subscribe({ collection: "todos" })
			await (
				await client2.connect()
			).result
			const delivery = Promise.withResolvers<void>()
			tabs.remote.pushBarrier = delivery.promise

			// The originating tab sees its edit immediately, even while server delivery is blocked.
			const tx = client2.transact()
			tx.set("todos", todo("waiting"))
			const committing = client2.commit(tx).then((call) => call.result)
			let completed = false
			void committing.then(() => {
				completed = true
			})
			expect(client2.query({ collection: "todos" })).toEqual([todo("waiting")])

			// Saving and sharing do not inherit the server's stalled completion.
			await (
				await client2.flushClientStorage()
			).result
			await expect
				.poll(() => client1.query({ collection: "todos" }))
				.toEqual([todo("waiting")])
			expect(completed).toBe(false)
			expect(await server.query({ collection: "todos" })).toEqual([])

			// Only the actual server response completes commit.
			delivery.resolve()
			await committing
			expect(await server.query({ collection: "todos" })).toEqual([
				todo("waiting"),
			])
		},
	)

	tabsTest(
		"a failed server commit rejects without losing the saved edit",
		async ({ tabs, server }) => {
			const first = await tabs.open("tab1")
			await using gatekeeper = new Gatekeeper()
				.add("client", () => first.client)
				.build()
			const { client } = gatekeeper
			client.subscribe({ collection: "todos" })
			await (
				await client.connect()
			).result
			await (
				await client.pullFromRemote()
			).result

			// The connected transport fails, so commit must report that failure to the caller.
			tabs.remote.down = true
			const tx = client.transact()
			tx.set("todos", todo("retained"))
			await expect((await client.commit(tx)).result).rejects.toThrow(
				"Remote push failed",
			)
			expect(client.query({ collection: "todos" })).toEqual([todo("retained")])

			// Reconnecting uses the existing retry policy and delivers the retained mutation.
			tabs.remote.down = false
			await (
				await client.connect()
			).result
			await expect
				.poll(() => server.query({ collection: "todos" }))
				.toEqual([todo("retained")])
		},
	)

	tabsTest(
		"a commit made while the first connection is pending waits for the server",
		async ({ tabs, server }) => {
			const connect = Promise.withResolvers<void>()
			tabs.remote.connectBarrier = connect.promise
			const first = await tabs.open("tab1")
			await using gatekeeper = new Gatekeeper()
				.add("client", () => first.client)
				.build()
			const { client } = gatekeeper
			await expect.poll(() => tabs.remote.connecting).toBeGreaterThan(0)

			// The write saves locally, but the server has not received it yet.
			const tx = client.transact()
			tx.set("todos", todo("before-connect"))
			const committed = client.commit(tx).then((call) => call.result)
			let complete = false
			void committed.then(() => {
				complete = true
			})
			await (
				await client.flushClientStorage()
			).result
			expect(complete).toBe(false)
			expect(await server.query({ collection: "todos" })).toEqual([])

			// Completing the connection pushes the write and completes the commit.
			connect.resolve()
			await committed
			expect(await server.query({ collection: "todos" })).toEqual([
				todo("before-connect"),
			])
		},
	)

	tabsTest(
		"a commit completes on the push that carried it while later sync is stalled",
		async ({ tabs, server }) => {
			// The commit's own push runs after the delayed connection lands, before the
			// connection's pull. Holding that pull must not hold the delivered commit.
			tabs.remote.connectDelayMs = 50
			tabs.remote.pullBarrier = never()
			const first = await tabs.open("tab1", { syncInterval: 100 })
			await using gatekeeper = new Gatekeeper()
				.add("client", () => first.client)
				.build()
			const { client } = gatekeeper
			const tx = client.transact()
			tx.set("todos", todo("delivered"))
			const committed = client.commit(tx).then((call) => call.result)
			let complete = false
			void committed.then(() => {
				complete = true
			})
			await expect.poll(() => complete).toBe(true)
			expect(await server.query({ collection: "todos" })).toEqual([
				todo("delivered"),
			])
		},
	)

	tabsTest(
		"a write whose leader save failed reaches the server through the next leader",
		async ({ tabs, server }) => {
			const first = await tabs.open("tab1")
			const second = await tabs.open("tab2")
			await using gatekeeper = new Gatekeeper()
				.add("client", () => second.client)
				.build()
			const { client } = gatekeeper
			client.subscribe({ collection: "todos" })
			await (
				await client.connect()
			).result

			// The leader cannot save the write, so commit rejects but the tab keeps the edit.
			tabs.storageFaults.failedWrites = Infinity
			const tx = client.transact()
			tx.set("todos", todo("unsaved"))
			await expect((await client.commit(tx)).result).rejects.toThrow(
				"Client storage commit failed",
			)
			expect(client.query({ collection: "todos" })).toEqual([todo("unsaved")])

			// The leader dies holding the write only in memory. The next leader receives
			// it again from the tab, and later writes still follow it in order.
			first.crash()
			tabs.storageFaults.failedWrites = 0
			const afterTx = client.transact()
			afterTx.set("todos", todo("after-takeover"))
			await (
				await client.commit(afterTx)
			).result
			const expected = [todo("after-takeover"), todo("unsaved")]
			await expect
				.poll(() => server.query({ collection: "todos" }))
				.toEqual(expected)
			expect(client.query({ collection: "todos" })).toEqual(expected)

			// Each write reached the server in one leader mutation.
			for (const id of ["unsaved", "after-takeover"]) {
				const carriers = new Set(
					tabs.pushed
						.filter(({ mutation }) =>
							mutation.ops.some(
								(op) => op.type === "set" && op.value.id === id,
							),
						)
						.map(({ clientId, mutation }) => `${clientId}:${mutation.id}`),
				)
				expect(carriers.size).toBe(1)
			}
		},
	)

	tabsTest(
		"a tab whose join to a new leader fails rejoins on its next request",
		async ({ tabs, server }) => {
			const first = await tabs.open("tab1")
			const second = await tabs.open("tab2")
			await using gatekeeper = new Gatekeeper()
				.add("client", () => second.client)
				.build()
			const { client } = gatekeeper
			client.subscribe({ collection: "todos" })

			// The new leader cannot save the joining tab's session, so the join fails
			// and the write waiting for it rejects.
			tabs.storageFaults.failingKey = "session"
			tabs.storageFaults.failedWrites = Infinity
			first.crash()
			const failedTx = client.transact()
			failedTx.set("todos", todo("during-failure"))
			await expect((await client.commit(failedTx)).result).rejects.toThrow(
				"Client storage commit failed",
			)

			// Once storage recovers, the next write rejoins and delivers both writes.
			tabs.storageFaults.failedWrites = 0
			const tx = client.transact()
			tx.set("todos", todo("after-recovery"))
			await (
				await client.commit(tx)
			).result
			expect(await server.query({ collection: "todos" })).toEqual([
				todo("after-recovery"),
				todo("during-failure"),
			])
		},
	)

	tabsTest(
		"tabs sharing storage deliver every write under their own client IDs",
		async ({ tabs, server }) => {
			const first = await tabs.open("tab1")
			first.client.subscribe({ collection: "todos" })
			const seedTx = first.client.transact()
			seedTx.set("todos", todo("a"))
			await first.client.commit(seedTx)

			// A tab opened after the first has written gets its own identity.
			const second = await tabs.open("tab2")
			second.client.subscribe({ collection: "todos" })
			expect(second.client.clientId).not.toBe(first.client.clientId)

			// Concurrent writes from both tabs all reach the server.
			const firstTx = first.client.transact()
			firstTx.set("todos", todo("b"))
			const secondTx = second.client.transact()
			secondTx.set("todos", todo("c"))
			await Promise.all([
				first.client.commit(firstTx),
				second.client.commit(secondTx),
			])
			const expected = [todo("a"), todo("b"), todo("c")]
			await expect
				.poll(() => server.query({ collection: "todos" }))
				.toEqual(expected)
			await expect
				.poll(() => first.client.query({ collection: "todos" }))
				.toEqual(expected)
			await expect
				.poll(() => second.client.query({ collection: "todos" }))
				.toEqual(expected)
		},
	)

	tabsTest(
		"a tab sees another tab's writes while the remote is unreachable",
		async ({ tabs, server }) => {
			const first = await tabs.open("tab1", { autoConnect: false })
			const second = await tabs.open("tab2", { autoConnect: false })
			first.client.subscribe({ collection: "todos" })
			second.client.subscribe({ collection: "todos" })

			const tx = second.client.transact()
			tx.set("todos", todo("offline", { text: "Written in tab 2" }))
			await second.client.commit(tx)

			await expect
				.poll(() => first.client.query({ collection: "todos" }))
				.toEqual([todo("offline", { text: "Written in tab 2" })])
			expect(await server.query({ collection: "todos" })).toEqual([])
		},
	)

	tabsTest(
		"offline writes from every tab survive closing all tabs and sync later",
		async ({ tabs, server }) => {
			const first = await tabs.open("tab1", { autoConnect: false })
			const second = await tabs.open("tab2", { autoConnect: false })

			// Each tab writes while the leader has never reached the remote.
			const firstTx = first.client.transact()
			firstTx.set("todos", todo("from-leader"))
			await first.client.commit(firstTx)
			const secondTx = second.client.transact()
			secondTx.set("todos", todo("from-follower"))
			await second.client.commit(secondTx)
			await second.client.close()
			await first.client.close()

			// A fresh tab restores both writes before it subscribes or connects.
			const reopened = await tabs.open("tab3", { autoConnect: false })
			const expected = [todo("from-follower"), todo("from-leader")]
			expect(reopened.client.query({ collection: "todos" })).toEqual(expected)
			expect(await server.query({ collection: "todos" })).toEqual([])

			// Connecting delivers both writes.
			await reopened.client.connect()
			await expect
				.poll(() => server.query({ collection: "todos" }))
				.toEqual(expected)
		},
	)

	tabsTest(
		"a follower takes over when the leader closes",
		async ({ tabs, server }) => {
			const first = await tabs.open("tab1")
			const second = await tabs.open("tab2")
			second.client.subscribe({ collection: "todos" })
			await first.client.close()

			const tx = second.client.transact()
			tx.set("todos", todo("after-handoff"))
			await second.client.commit(tx)
			await expect
				.poll(() => server.query({ collection: "todos" }))
				.toEqual([todo("after-handoff")])
		},
	)

	tabsTest(
		"a follower that resends after the leader crashes does not apply its write twice",
		async ({ tabs, server }) => {
			let crashLeader = () => {}
			const first = await tabs.open("tab1", {
				// Crash after the forwarded write and its session marker are saved,
				// before the follower hears that the leader has it.
				afterStorageCommit: (writes) => {
					if (writes.set?.some(({ key }) => key[0] === "tab-write"))
						crashLeader()
				},
			})
			crashLeader = () => first.crash()
			const second = await tabs.open("tab2")
			second.client.subscribe({ collection: "todos" })

			const tx = second.client.transact()
			tx.set("todos", todo("once"))
			await second.client.commit(tx)

			await expect
				.poll(() => server.query({ collection: "todos" }))
				.toEqual([todo("once")])
			await expect
				.poll(() => second.client.query({ collection: "todos" }))
				.toEqual([todo("once")])
			// One leader mutation carries the write, however often it was sent.
			const carriers = new Set(
				tabs.pushed
					.filter(({ mutation }) =>
						mutation.ops.some(
							(op) => op.type === "set" && op.value.id === "once",
						),
					)
					.map(({ clientId, mutation }) => `${clientId}:${mutation.id}`),
			)
			expect(carriers.size).toBe(1)
		},
	)

	tabsTest(
		"a new leader keeps syncing what the tabs synced, without removing it first",
		async ({ tabs, server }) => {
			const first = await tabs.open("tab1")
			first.client.subscribe({ collection: "todos" })
			const tx = first.client.transact()
			tx.set("todos", todo("kept"))
			await first.client.commit(tx)
			await expect
				.poll(() => server.query({ collection: "todos" }))
				.toEqual([todo("kept")])

			const second = await tabs.open("tab2")
			second.client.subscribe({ collection: "todos" })
			await expect
				.poll(() => second.client.query({ collection: "todos" }))
				.toEqual([todo("kept")])

			// Every remote pull after the handoff carries tab 2's query, so the
			// server never answers with a removal for records tab 2 still syncs.
			await first.client.close()
			const pullsBeforeHandoff = tabs.pulls.length
			const tx2 = second.client.transact()
			tx2.set("todos", todo("after"))
			await second.client.commit(tx2)
			await expect
				.poll(() => server.query({ collection: "todos" }))
				.toEqual([todo("after"), todo("kept")])
			const handoffPulls = tabs.pulls.slice(pullsBeforeHandoff)
			expect(handoffPulls.length).toBeGreaterThan(0)
			expect(
				handoffPulls.every(({ scanWindow }) => scanWindow.length > 0),
			).toBe(true)
		},
	)

	tabsTest(
		"a tab refuses to transact before joining the leader restores the replica",
		async ({ tabs }) => {
			const first = await tabs.open("tab1", { autoConnect: false })
			const tx = first.client.transact()
			tx.set("todos", todo("restored"))
			await first.client.commit(tx)

			// The in-memory replica is ready immediately, but holds nothing until
			// the leader answers, so ready stays the restore barrier here too.
			const second = await tabs.open("tab2", {
				autoConnect: false,
				awaitReady: false,
			})
			expect(() => second.client.transact()).toThrow(
				"Await client.ready before creating a transaction",
			)
			await second.client.ready
			expect(second.client.query({ collection: "todos" })).toEqual([
				todo("restored"),
			])
			expect(() => second.client.transact()).not.toThrow()
		},
	)

	tabsTest(
		"records a tab restored at startup survive views of its subscriptions",
		async ({ tabs }) => {
			const first = await tabs.open("tab1", { autoConnect: false })
			const tx = first.client.transact()
			tx.set("todos", todo("restored"))
			await first.client.commit(tx)
			const second = await tabs.open("tab2", { autoConnect: false })

			// A later view covers only tab 2's subscriptions, which exclude the record.
			second.client.subscribe({ collection: "todos", where: { id: "other" } })
			const otherTx = first.client.transact()
			otherTx.set("todos", todo("other"))
			await first.client.commit(otherTx)
			await second.client.pullFromRemote()
			expect(second.client.query({ collection: "todos" })).toEqual([
				todo("other"),
				todo("restored"),
			])
		},
	)

	tabsTest(
		"records a tab restored at startup are removed once deleted",
		async ({ tabs }) => {
			const first = await tabs.open("tab1", { autoConnect: false })
			const tx = first.client.transact()
			tx.set("todos", todo("deleted-later"))
			await first.client.commit(tx)

			// Tab 2 restores the record before subscribing to anything.
			const second = await tabs.open("tab2", { autoConnect: false })
			expect(second.client.query({ collection: "todos" })).toEqual([
				todo("deleted-later"),
			])

			const removeTx = first.client.transact()
			removeTx.remove("todos", "deleted-later")
			await first.client.commit(removeTx)
			second.client.subscribe({ collection: "todos" })
			await expect
				.poll(() => second.client.query({ collection: "todos" }))
				.toEqual([])
		},
	)

	tabsTest(
		"connect recovers after automatic connection failed",
		async ({ tabs, server }) => {
			tabs.remote.down = true
			const first = await tabs.open("tab1")
			const tx = first.client.transact()
			tx.set("todos", todo("queued"))
			await first.client.commit(tx)

			tabs.remote.down = false
			await first.client.connect()
			await expect
				.poll(() => server.query({ collection: "todos" }))
				.toEqual([todo("queued")])
		},
	)

	for (const reconnectingTab of ["client1", "client2"] as const) {
		tabsTest(
			`${reconnectingTab} reconnects an existing leader after a failed push`,
			async ({ tabs, server }) => {
				const first = await tabs.open("tab1", { autoConnect: false })
				const second = await tabs.open("tab2", { autoConnect: false })
				await using gatekeeper = new Gatekeeper()
					.add("client1", () => first.client)
					.add("client2", () => second.client)
					.build()
				const { client1, client2 } = gatekeeper
				client1.subscribe({ collection: "todos" })
				await (
					await client1.connect()
				).result
				await (
					await client1.pullFromRemote()
				).result

				// The leader has a connection, but delivery of this durable write fails.
				tabs.remote.down = true
				const tx = client2.transact()
				tx.set("todos", todo("retry"))
				await (
					await client2.commit(tx)
				).result
				await expect.poll(() => tabs.remote.failedPushes).toBeGreaterThan(0)

				// Either tab can retry delivery without another write or a leader change.
				tabs.remote.down = false
				await (
					await gatekeeper[reconnectingTab].connect()
				).result
				await expect
					.poll(() => server.query({ collection: "todos" }))
					.toEqual([todo("retry")])
			},
		)
	}

	tabsTest(
		"reconnecting an existing leader does not wait for a stalled push",
		async ({ tabs }) => {
			const first = await tabs.open("tab1", { autoConnect: false })
			await using gatekeeper = new Gatekeeper()
				.add("client1", () => first.client)
				.build()
			const { client1 } = gatekeeper
			await (
				await client1.connect()
			).result
			await (
				await client1.pullFromRemote()
			).result
			tabs.remote.pushHangs = true
			const tx = client1.transact()
			tx.set("todos", todo("stalled-reconnect"))
			const committing = client1.commit(tx).then((call) => call.result)
			await expect.poll(() => tabs.remote.stalledPushes).toBeGreaterThan(0)

			// Reconnect schedules synchronization without blocking connection control.
			await (
				await client1.connect()
			).result
			await (
				await client1.disconnect()
			).result
			await (
				await client1.flushClientStorage()
			).result
			await (
				await client1.close()
			).result
			await expect(committing).rejects.toThrow("Tab session closed")
		},
	)

	tabsTest(
		"saving and handoff do not wait for a stalled server commit",
		async ({ tabs }) => {
			const first = await tabs.open("tab1")
			const second = await tabs.open("tab2")
			tabs.remote.pushHangs = true

			const tx = second.client.transact()
			tx.set("todos", todo("saved"))
			const committed = second.client.commit(tx)
			await second.client.flushClientStorage()

			// The leader saves and hands off; a reopened tab restores the write.
			await first.client.close()
			await second.client.close()
			await expect(committed).rejects.toThrow("Tab session closed")
			const reopened = await tabs.open("tab3", { autoConnect: false })
			expect(reopened.client.query({ collection: "todos" })).toEqual([
				todo("saved"),
			])
		},
	)

	tabsTest(
		"one tab disconnecting leaves the leader connected for the others",
		async ({ tabs, server }) => {
			const first = await tabs.open("tab1")
			const second = await tabs.open("tab2")
			await second.client.disconnect()

			const tx = first.client.transact()
			tx.set("todos", todo("still-synced"))
			await first.client.commit(tx)
			await expect
				.poll(() => server.query({ collection: "todos" }))
				.toEqual([todo("still-synced")])
		},
	)

	tabsTest(
		"clear in one tab completes while other tabs hold the storage open",
		async ({ tabs, server }) => {
			const first = await tabs.open("tab1")
			const second = await tabs.open("tab2")
			const tx = first.client.transact()
			tx.set("todos", todo("before-clear"))
			await first.client.commit(tx)
			// commit resolves once leader storage holds the write, and clear discards
			// pending mutations. Let this one reach the remote, so what the test
			// checks afterwards is that clear leaves server writes alone.
			await expect
				.poll(() => server.query({ collection: "todos" }))
				.toEqual([todo("before-clear")])

			await first.client.clear()
			expect(first.client.query({ collection: "todos" })).toEqual([])

			// Sync still works for every tab afterwards.
			const afterTx = second.client.transact()
			afterTx.set("todos", todo("after-clear"))
			await second.client.commit(afterTx)
			await second.client.flushClientStorage()
			await expect
				.poll(() => server.query({ collection: "todos" }))
				.toEqual([todo("after-clear"), todo("before-clear")])
		},
	)

	tabsTest(
		"a write made while clear is in flight completes in the cleared replica",
		async ({ tabs, server }) => {
			await tabs.open("tab1")
			const second = await tabs.open("tab2")
			second.client.subscribe({ collection: "todos" })
			const beforeTx = second.client.transact()
			beforeTx.set("todos", todo("before-clear"))
			await second.client.commit(beforeTx)

			// The write follows the clear request, so the clear does not discard it.
			const clearing = second.client.clear()
			const tx = second.client.transact()
			tx.set("todos", todo("during-clear"))
			const committed = second.client.commit(tx)
			await clearing
			await committed
			expect(await server.query({ collection: "todos" })).toEqual([
				todo("before-clear"),
				todo("during-clear"),
			])
			await expect
				.poll(() => second.client.query({ collection: "todos" }))
				.toEqual([todo("before-clear"), todo("during-clear")])
		},
	)

	tabsTest(
		"a closed leader stops syncing even if its connection finishes later",
		async ({ tabs }) => {
			tabs.remote.connectDelayMs = 50
			const first = await tabs.open("tab1")
			await tabs.open("tab2")
			await first.client.close()

			const pullsAfterClose = tabs.pulls.length
			await new Promise((resolve) => setTimeout(resolve, 200))
			expect(
				tabs.pulls.slice(pullsAfterClose).filter(({ tab }) => tab === "tab1"),
			).toEqual([])
		},
	)

	tabsTest(
		"clear does not wait for a stalled remote push",
		async ({ tabs }) => {
			const first = await tabs.open("tab1", { autoConnect: false })
			const tx = first.client.transact()
			tx.set("todos", todo("stalled"))
			await first.client.commit(tx)

			// Connecting pushes the queued write, which stalls at the remote.
			tabs.remote.pushHangs = true
			void first.client.connect()
			await expect.poll(() => tabs.remote.stalledPushes).toBeGreaterThan(0)
			await first.client.clear()
			expect(first.client.query({ collection: "todos" })).toEqual([])
		},
	)

	tabsTest(
		"tabs reach the leader without waiting for the sync interval",
		async ({ tabs }) => {
			// A minute between remote syncs; tabs must not wait on it to reach the leader.
			const first = await tabs.open("tab1", {
				syncInterval: 60_000,
				autoConnect: false,
			})
			const second = await tabs.open("tab2", {
				syncInterval: 60_000,
				autoConnect: false,
			})
			first.client.subscribe({ collection: "todos" })

			const tx = second.client.transact()
			tx.set("todos", todo("local"))
			await second.client.commit(tx)
			await expect
				.poll(() => first.client.query({ collection: "todos" }))
				.toEqual([todo("local")])
		},
	)

	tabsTest(
		"a hidden leader syncs with the remote without waiting on throttled timers",
		async ({ tabs, server }) => {
			// Hidden tabs delay timers; a minute-long interval stands in for that.
			vi.stubGlobal("document", {
				visibilityState: "hidden",
				addEventListener() {},
				removeEventListener() {},
			})
			try {
				const first = await tabs.open("tab1", { syncInterval: 60_000 })
				first.client.subscribe({ collection: "todos" })

				// A tab's write reaches the remote.
				const tx = first.client.transact()
				tx.set("todos", todo("pushed"))
				await first.client.commit(tx)
				await expect
					.poll(() => server.query({ collection: "todos" }))
					.toEqual([todo("pushed")])

				// A remote change reaches the tab.
				const serverTx = server.transact()
				serverTx.set("todos", todo("pulled"))
				await server.commit(serverTx)
				await expect
					.poll(() => first.client.query({ collection: "todos" }))
					.toEqual([todo("pulled"), todo("pushed")])
			} finally {
				vi.unstubAllGlobals()
			}
		},
	)

	class EventStart {
		constructor(readonly iso: string) {}

		format() {
			return this.iso
		}
	}

	type EventsSchema = {
		events: { id: string; startAt: EventStart }
	}

	const eventsSchema = defineSchema({
		events: collection<EventsSchema["events"], { id: string; startAt: string }>(
			{
				fields: ["id", "startAt"],
				codec: partialObject({
					id: string,
					startAt: codec<EventStart, string>(
						"event-start",
						(input) => (input as EventStart).iso,
						(input) => new EventStart(input as string),
					),
				}),
			},
		),
	}) as RuntimeSchemaDefinition<EventsSchema>

	for (const configuration of [
		"explicit",
		"storage-schema",
		"override",
	] as const) {
		test(`${configuration} storage codecs preserve methods through startup and handoff`, async ({
			makeRemote,
			makeStorage,
			logger,
			rng,
		}) => {
			class StorageEventStart extends EventStart {
				override format() {
					return `Event starts at ${this.iso}`
				}
			}
			const storageCodec = partialObject({
				id: string,
				startAt: codec<EventStart, string>(
					"storage-event-start",
					(input) => (input as EventStart).iso,
					(input) => new StorageEventStart(input as string),
				),
			})
			const storageSchema = defineSchema({
				events: collection<
					EventsSchema["events"],
					{ id: string; startAt: string }
				>({
					fields: ["id", "startAt"],
					codec: storageCodec,
				}),
			})
			const server = makeRemote({ schema: eventsSchema, relations: {} })
			const tabs = createTabs<EventsSchema>({
				server,
				schema: configuration === "override" ? eventsSchema : undefined,
				dbName: rng.next("storage-codecs"),
				makeStorage: ({ dbName }) =>
					makeStorage<EventsSchema>({
						dbName,
						schema:
							configuration === "storage-schema" ? storageSchema : undefined,
						codecs:
							configuration === "storage-schema"
								? undefined
								: { events: storageCodec },
					}),
				logger,
				rng,
			})
			await using cleanup = new errore.AsyncDisposableStack()
			cleanup.defer(() => tabs.close())
			const first = await tabs.open("tab1", { autoConnect: false })
			const second = await tabs.open("tab2", { autoConnect: false })
			await using gatekeeper = new Gatekeeper()
				.add("client1", () => first.client)
				.add("client2", () => second.client)
				.build()
			const { client1, client2 } = gatekeeper
			client1.subscribe({ collection: "events" })
			client2.subscribe({ collection: "events" })
			const iso = "2026-10-22T09:00:00.000Z"
			const expected = `Event starts at ${iso}`

			// Forwarding must restore the methods supplied by the storage codec.
			const tx = client2.transact()
			tx.set("events", { id: "launch", startAt: new StorageEventStart(iso) })
			await (
				await client2.commit(tx)
			).result
			await expect
				.poll(() =>
					client1.query({ collection: "events" })[0]?.startAt.format(),
				)
				.toBe(expected)

			// A new tab's initial snapshot must preserve the same runtime values.
			const third = await tabs.open("tab3", { autoConnect: false })
			await using thirdGatekeeper = new Gatekeeper()
				.add("client", () => third.client)
				.build()
			expect(
				thirdGatekeeper.client
					.query({ collection: "events" })[0]
					?.startAt.format(),
			).toBe(expected)

			// Takeover and an actual storage reload must use those codecs too.
			await (
				await client1.close()
			).result
			const afterTx = client2.transact()
			afterTx.set("events", {
				id: "after",
				startAt: new StorageEventStart(iso),
			})
			await (
				await client2.commit(afterTx)
			).result
			await (
				await client2.close()
			).result
			await (
				await thirdGatekeeper.client.close()
			).result
			const restored = await tabs.open("tab4", { autoConnect: false })
			await using restoredGatekeeper = new Gatekeeper()
				.add("client", () => restored.client)
				.build()
			expect(
				restoredGatekeeper.client
					.query({ collection: "events" })
					.map((event) => event.startAt.format()),
			).toEqual([expected, expected])
		})
	}

	test("collection codecs restore values that cross tabs", async ({
		makeRemote,
		makeStorage,
		logger,
		rng,
	}) => {
		const server = makeRemote({ schema: eventsSchema, relations: {} })
		const tabs = createTabs<EventsSchema>({
			server,
			schema: eventsSchema,
			dbName: rng.next("events-storage"),
			makeStorage: (options) => makeStorage<EventsSchema>(options),
			logger,
			rng,
		})
		try {
			const first = await tabs.open("tab1")
			const second = await tabs.open("tab2")
			first.client.subscribe({ collection: "events" })

			const tx = second.client.transact()
			tx.set("events", {
				id: "launch",
				startAt: new EventStart("2026-10-22T09:00:00.000Z"),
			})
			await second.client.commit(tx)
			await expect
				.poll(() => first.client.query({ collection: "events" }))
				.toHaveLength(1)
			const [event] = first.client.query({ collection: "events" })
			expect(event?.startAt).toBeInstanceOf(EventStart)
			expect(event?.startAt.iso).toBe("2026-10-22T09:00:00.000Z")
		} finally {
			await tabs.close()
		}
	})
})
