import {
	type ClientApi,
	collection,
	defineRelations,
	defineSchema,
	type PokePayload,
	type RemoteApi,
	t,
	TandemClient,
	type TandemClientStorageApi,
	type TimerApi,
} from "@tanishqkancharla/tandem-core"
import type { TandemServer } from "@tanishqkancharla/tandem-server"
import * as errore from "errore"
import { describe, expect, vi } from "vitest"
import { buildGatekeeperHarness, type DemoRng, test } from "../fixtures.js"
import type { Logger } from "@tanishqkancharla/tandem-core"

type Thread = { id: string; title: string }
type Message = { id: string; threadId: string; text: string }
type ChatSchema = { threads: Thread; messages: Message }

const chatSchema = defineSchema({
	threads: collection({ id: t.id(), title: t.string() }),
	messages: collection({ id: t.id(), threadId: t.string(), text: t.string() }),
})

const chatRelations = defineRelations(chatSchema, ({ many }) => ({
	threads: { messages: many("messages", { from: "id", to: "threadId" }) },
}))

type ChatServer = TandemServer<ChatSchema, typeof chatRelations>
type ChatClient = TandemClient<ChatSchema, typeof chatRelations>

const reply = (text: string): Message => ({
	id: "reply",
	threadId: "thread-1",
	text,
})

/**
 * Holds every poke the server sends, so a test decides when, and whether, each
 * one reaches its client. Pulls and pushes go straight to the server.
 */
class HeldPokes {
	private held: {
		payload?: PokePayload<ChatSchema>
		deliver: () => Promise<void>
	}[] = []
	readonly connections: ClientApi<ChatSchema>[] = []

	constructor(private readonly server: ChatServer) {}

	readonly remote: RemoteApi<ChatSchema> = {
		connect: (client) => {
			this.connections.push(client)
			return this.server.connect({
				...client,
				poke: (payload) => {
					this.held.push({ payload, deliver: () => client.poke(payload) })
					return Promise.resolve()
				},
			})
		},
		pull: (args) => {
			this.pulls += 1
			return this.server.pull(args)
		},
		push: (args) => this.server.push(args),
	}

	/** Pulls that reached the server. */
	pulls = 0

	/** Removes held pokes. Each applies at once when called and settles after its pull. */
	take(): (() => Promise<void>)[] {
		return this.held.splice(0).map(({ deliver }) => deliver)
	}

	/** Removes held pokes without delivering them, and returns their payloads. */
	takePayloads(): (PokePayload<ChatSchema> | undefined)[] {
		return this.held.splice(0).map(({ payload }) => payload)
	}

	/** Delivers held pokes in order. */
	deliver(): Promise<void[]> {
		return Promise.all(this.take().map((poke) => poke()))
	}

	drop() {
		this.held = []
	}
}

function createClient({
	remote,
	logger,
	rng,
	clientStorage,
	livePullDelay,
	livePullMaxDelay,
}: {
	remote: RemoteApi<ChatSchema>
	logger: Logger
	rng: DemoRng
	clientStorage?: TandemClientStorageApi<ChatSchema>
	livePullDelay?: TimerApi
	livePullMaxDelay?: TimerApi
}): ChatClient {
	return new TandemClient({
		schema: chatSchema,
		relations: chatRelations,
		remote,
		logger,
		rng: rng.create("client"),
		clientStorage,
		autoConnect: false,
		syncInterval: 0,
		livePullDelay,
		livePullMaxDelay,
	})
}

/** A timer whose ticks happen only when the test says so. */
class ManualTimer implements TimerApi {
	private waiting: (() => void)[] = []

	waitForNextTick(): Promise<void> {
		return new Promise((resolve) => this.waiting.push(resolve))
	}

	/** Delivers the pending tick and lets its work reach the next await. */
	async tick() {
		for (const resolve of this.waiting.splice(0)) resolve()
		await new Promise((resolve) => setImmediate(resolve))
	}
}

async function useConnectedHarness(
	pokes: HeldPokes,
	create: (remote: RemoteApi<ChatSchema>) => ChatClient,
	use: (harness: ChatHarness) => Promise<void>,
) {
	const clients: ChatClient[] = []
	await using cleanup = new errore.AsyncDisposableStack()
	await using harness = buildGatekeeperHarness({
		server: pokes.remote,
		createClient: (remote) => {
			const client = create(remote)
			clients.push(client)
			cleanup.defer(() => client.disconnect())
			return client
		},
	})
	for (const client of clients) {
		await client.ready
		await client.connect()
	}
	await use(harness)
	await harness.deactivateGatesAndSettle()
}

type ChatHarness = ReturnType<
	typeof buildGatekeeperHarness<ChatSchema, ChatClient>
>

const serverTest = test.extend<{
	chat: ChatServer
	pokes: HeldPokes
	commitOnServer: (
		write: (tx: ReturnType<ChatServer["transact"]>) => void,
	) => Promise<void>
}>({
	chat: async ({ makeRemote }, use) => {
		await use(
			makeRemote({
				schema: chatSchema,
				relations: chatRelations,
				// Each commit's payload goes out on its own, so a test can hold or
				// drop any one of them.
				livePokeInterval: 0,
			}),
		)
	},
	pokes: async ({ chat }, use) => {
		await use(new HeldPokes(chat))
	},
	commitOnServer: async ({ chat }, use) => {
		await use(async (write) => {
			const tx = chat.transact()
			write(tx)
			await chat.commit(tx)
		})
	},
})

const liveTest = serverTest.extend<{ harness: ChatHarness }>({
	harness: async ({ pokes, logger, rng }, use) => {
		await useConnectedHarness(
			pokes,
			(remote) => createClient({ remote, logger, rng }),
			use,
		)
	},
})

describe("live pokes", () => {
	liveTest(
		"a poke shows the server's records before the pull that confirms them",
		async ({ harness, pokes, commitOnServer }) => {
			const { client1 } = harness
			const seen: Message[][] = []
			client1.subscribe({ collection: "messages" }, (messages) =>
				seen.push(messages),
			)
			await (
				await client1.pullFromRemote()
			).result

			await commitOnServer((tx) => tx.set("messages", reply("Hel")))
			const pulled = pokes.deliver()

			// Queries and subscriptions see the record in the same tick.
			expect(client1.query({ collection: "messages" })).toEqual([reply("Hel")])
			expect(seen.at(-1)).toEqual([reply("Hel")])
			await pulled
			expect(client1.query({ collection: "messages" })).toEqual([reply("Hel")])
		},
	)

	liveTest(
		"a pull that read the server before a newer commit keeps the newer live record",
		async ({ harness, pokes, commitOnServer }) => {
			const { client1 } = harness
			client1.subscribe({ collection: "messages" })
			await commitOnServer((tx) => tx.set("messages", reply("Hel")))
			await (
				await client1.pullFromRemote()
			).result
			pokes.drop()

			await harness.activateGates()
			const stalePull = await client1.pullFromRemote()
			await stalePull.continueTo("server")
			// The server saves more after it answered the pull.
			await commitOnServer((tx) => tx.set("messages", reply("Hello")))
			void pokes.deliver()
			expect(client1.query({ collection: "messages" })).toEqual([
				reply("Hello"),
			])
			await stalePull.continueToCompletion()

			expect(client1.query({ collection: "messages" })).toEqual([
				reply("Hello"),
			])
		},
	)

	liveTest(
		"a pull at or after a live record's revision replaces it",
		async ({ harness, pokes, commitOnServer }) => {
			const { client1 } = harness
			client1.subscribe({ collection: "messages" })
			await (
				await client1.pullFromRemote()
			).result

			// A pull waits to read the server while a poke shows a live record.
			await harness.activateGates()
			const pull = await client1.pullFromRemote()
			await commitOnServer((tx) => tx.set("messages", reply("Hel")))
			void pokes.deliver()
			expect(client1.query({ collection: "messages" })).toEqual([reply("Hel")])

			// The next commit's poke is lost; the waiting pull then reads it.
			await commitOnServer((tx) => tx.set("messages", reply("Hello")))
			pokes.drop()
			await pull.continueToCompletion()

			expect(client1.query({ collection: "messages" })).toEqual([
				reply("Hello"),
			])
		},
	)

	liveTest(
		"pokes older than the latest pull or the visible live record are ignored",
		async ({ harness, pokes, commitOnServer }) => {
			const { client1 } = harness
			client1.subscribe({ collection: "messages" })
			await commitOnServer((tx) => tx.set("messages", reply("H")))
			await (
				await client1.pullFromRemote()
			).result
			await commitOnServer((tx) => tx.set("messages", reply("He")))
			const [beforePull] = pokes.take()
			await commitOnServer((tx) => tx.set("messages", reply("Hel")))
			await (
				await client1.pullFromRemote()
			).result
			await commitOnServer((tx) => tx.set("messages", reply("Hell")))
			await commitOnServer((tx) => tx.set("messages", reply("Hello")))
			const [older, newest] = pokes.take().slice(-2)

			// A poke the latest pull already reflects does not move the record back.
			void beforePull!()
			expect(client1.query({ collection: "messages" })).toEqual([reply("Hel")])

			// Nor does one older than the live record shown.
			void newest!()
			void older!()
			expect(client1.query({ collection: "messages" })).toEqual([
				reply("Hello"),
			])
		},
	)

	liveTest(
		"a poke delivers a delete before the pull",
		async ({ harness, pokes, commitOnServer }) => {
			const { client1 } = harness
			client1.subscribe({ collection: "messages" })
			await commitOnServer((tx) => tx.set("messages", reply("Hel")))
			await (
				await client1.pullFromRemote()
			).result
			pokes.drop()

			await commitOnServer((tx) => tx.remove("messages", "reply"))
			void pokes.deliver()

			expect(client1.query({ collection: "messages" })).toEqual([])
		},
	)

	liveTest(
		"a reset snapshot read before a commit keeps that commit's live record",
		async ({ harness, pokes, commitOnServer }) => {
			const { client1 } = harness
			client1.subscribe({ collection: "messages" })
			await (
				await client1.pullFromRemote()
			).result

			// Losing a pull response makes the next pull a reset snapshot.
			await harness.activateGates()
			const lostPull = await client1.pullFromRemote()
			await lostPull.continueTo("server")
			await lostPull.fail(new Error("Lost response"))
			await expect(lostPull.result).rejects.toThrow()
			const resetPull = await client1.pullFromRemote()
			await resetPull.continueTo("server")
			await commitOnServer((tx) => tx.set("messages", reply("Hel")))
			void pokes.deliver()
			await resetPull.continueToCompletion()

			expect(client1.query({ collection: "messages" })).toEqual([reply("Hel")])
		},
	)

	liveTest(
		"records included through a relation arrive live",
		async ({ harness, pokes, commitOnServer }) => {
			const { client1 } = harness
			const thread = {
				collection: "threads",
				where: { id: "thread-1" },
				with: { messages: true },
			} as const
			client1.subscribe(thread)
			await commitOnServer((tx) =>
				tx.set("threads", { id: "thread-1", title: "Chat" }),
			)
			await (
				await client1.pullFromRemote()
			).result
			pokes.drop()

			await commitOnServer((tx) => tx.set("messages", reply("Hel")))
			void pokes.deliver()

			expect(client1.query(thread)).toEqual([
				{ id: "thread-1", title: "Chat", messages: [reply("Hel")] },
			])
		},
	)

	liveTest(
		"pending local writes stay visible over live records, including after a stale pull",
		async ({ harness, pokes, commitOnServer }) => {
			const { client1 } = harness
			client1.subscribe({ collection: "messages" })
			await commitOnServer((tx) => tx.set("messages", reply("Hel")))
			await (
				await client1.pullFromRemote()
			).result
			pokes.drop()

			// A stale pull, a local update, and a newer live record all overlap.
			await harness.activateGates()
			const stalePull = await client1.pullFromRemote()
			await stalePull.continueTo("server")
			const localTx = client1.transact()
			localTx.update("messages", "reply", { threadId: "thread-2" })
			// The push waits behind the held pull, so do not wait for its handle.
			const commit = client1.commit(localTx)
			await commitOnServer((tx) => tx.set("messages", reply("Hello")))
			void pokes.deliver()

			// The live text shows under the pending update.
			expect(client1.query({ collection: "messages" })).toEqual([
				{ ...reply("Hello"), threadId: "thread-2" },
			])
			await stalePull.continueToCompletion()
			expect(client1.query({ collection: "messages" })).toEqual([
				{ ...reply("Hello"), threadId: "thread-2" },
			])

			// A local set replaces the live value outright until the server answers.
			const setTx = client1.transact()
			setTx.set("messages", reply("Mine"))
			const setCommit = client1.commit(setTx)
			expect(client1.query({ collection: "messages" })).toEqual([reply("Mine")])
			await harness.deactivateGatesAndSettle()
			await (
				await commit
			).result
			await (
				await setCommit
			).result
			await (
				await client1.pullFromRemote()
			).result
			expect(client1.query({ collection: "messages" })).toEqual([reply("Mine")])
		},
	)

	test("a restarted client shows its last synced records, not live ones", async ({
		makeRemote,
		makeStorage,
		logger,
		rng,
	}) => {
		const chat = makeRemote({
			schema: chatSchema,
			relations: chatRelations,
			livePokeInterval: 0,
		})
		const pokes = new HeldPokes(chat)
		const storage = makeStorage<ChatSchema>({ schema: chatSchema })
		const commitOnServer = async (message: Message) => {
			const tx = chat.transact()
			tx.set("messages", message)
			await chat.commit(tx)
		}
		await commitOnServer(reply("Hel"))
		await commitOnServer({ ...reply("Other"), id: "other" })

		const first = createClient({
			remote: pokes.remote,
			logger,
			rng,
			clientStorage: storage,
		})
		await first.ready
		await first.connect()
		first.subscribe({ collection: "messages" })
		await first.pullFromRemote()
		// One live record has a pending local write under it, one does not.
		const tx = first.transact()
		tx.update("messages", "other", { threadId: "thread-2" })
		void first.commit(tx).catch(() => {})
		pokes.drop()
		await commitOnServer(reply("Hello"))
		await commitOnServer({ ...reply("Other live"), id: "other" })
		void pokes.deliver()
		expect(first.query({ collection: "messages" })).toEqual([
			{ ...reply("Other live"), id: "other", threadId: "thread-2" },
			reply("Hello"),
		])
		// Disconnecting at once keeps the pokes' pulls from running.
		const disconnected = first.disconnect()
		await first.flushClientStorage()
		await disconnected

		const restarted = createClient({
			remote: pokes.remote,
			logger,
			rng,
			clientStorage: storage,
		})
		await restarted.ready
		expect(restarted.query({ collection: "messages" })).toEqual([
			{ ...reply("Other"), id: "other", threadId: "thread-2" },
			reply("Hel"),
		])
	})

	liveTest(
		"a live append grows the record before the pull confirms it",
		async ({ harness, pokes, commitOnServer }) => {
			const { client1 } = harness
			client1.subscribe({ collection: "messages" })
			await commitOnServer((tx) => tx.set("messages", reply("Hel")))
			await (
				await client1.pullFromRemote()
			).result
			pokes.drop()

			await commitOnServer((tx) =>
				tx.append("messages", "reply", { text: "lo" }),
			)
			await commitOnServer((tx) =>
				tx.append("messages", "reply", { text: "!" }),
			)
			const pulled = pokes.deliver()

			expect(client1.query({ collection: "messages" })).toEqual([
				reply("Hello!"),
			])
			await pulled
			expect(client1.query({ collection: "messages" })).toEqual([
				reply("Hello!"),
			])
		},
	)

	liveTest(
		"appends keep applying while a pull that read a later commit is in flight",
		async ({ harness, pokes, commitOnServer }) => {
			const { client1 } = harness
			client1.subscribe({ collection: "messages" })
			await (
				await client1.pullFromRemote()
			).result

			// The server answers a pull after writing the reply and another record.
			await harness.activateGates()
			await commitOnServer((tx) => tx.set("messages", reply("Hel")))
			const [replyPoke] = pokes.take()
			await commitOnServer((tx) =>
				tx.set("messages", { ...reply("Other"), id: "other" }),
			)
			pokes.drop()
			const pull = await client1.pullFromRemote()
			await pull.continueTo("server")

			// Before its response arrives, the client shows the reply's poke and
			// then an append to it.
			void replyPoke!()
			await commitOnServer((tx) =>
				tx.append("messages", "reply", { text: "lo" }),
			)
			void pokes.deliver()
			expect(client1.query({ collection: "messages" })).toEqual([
				reply("Hello"),
			])

			await harness.deactivateGatesAndSettle()
			await commitOnServer((tx) =>
				tx.append("messages", "reply", { text: "!" }),
			)
			void pokes.deliver()
			expect(client1.query({ collection: "messages" })).toEqual([
				{ ...reply("Other"), id: "other" },
				reply("Hello!"),
			])
		},
	)

	liveTest(
		"an append that arrives after a newer payload for its record is ignored",
		async ({ harness, pokes, commitOnServer }) => {
			const { client1 } = harness
			client1.subscribe({ collection: "messages" })
			await commitOnServer((tx) => tx.set("messages", reply("ab")))
			await (
				await client1.pullFromRemote()
			).result
			pokes.drop()

			// A reconnecting client can get the same pokes over two connections,
			// so an older payload can arrive after a newer one.
			await commitOnServer((tx) =>
				tx.append("messages", "reply", { text: "c" }),
			)
			await commitOnServer((tx) => tx.set("messages", reply("zz")))
			const [older, newer] = pokes.take()
			void newer!()
			void older!()

			expect(client1.query({ collection: "messages" })).toEqual([reply("zz")])
		},
	)

	liveTest(
		"an append that does not start at the end of the client's text waits for the pull",
		async ({ harness, pokes, commitOnServer }) => {
			const { client1 } = harness
			client1.subscribe({ collection: "messages" })
			await commitOnServer((tx) => tx.set("messages", reply("Hel")))
			await (
				await client1.pullFromRemote()
			).result
			pokes.drop()

			// A custom remote sends an append whose offset is past the client's text.
			await commitOnServer((tx) =>
				tx.append("messages", "reply", { text: "lo" }),
			)
			const [payload] = pokes.takePayloads()
			const pulled = pokes.connections[0]!.poke({
				...payload!,
				append: payload!.append!.map((op) => ({
					...op,
					offset: op.offset + 1,
				})),
			})
			expect(client1.query({ collection: "messages" })).toEqual([reply("Hel")])

			await pulled
			expect(client1.query({ collection: "messages" })).toEqual([
				reply("Hello"),
			])
		},
	)

	liveTest(
		"an append after a lost poke waits for the pull, even when the lengths line up",
		async ({ harness, pokes, commitOnServer }) => {
			const { client1 } = harness
			client1.subscribe({ collection: "messages" })
			await commitOnServer((tx) => tx.set("messages", reply("Hel")))
			await (
				await client1.pullFromRemote()
			).result
			pokes.drop()

			// A lost append leaves the client's text short.
			await commitOnServer((tx) =>
				tx.append("messages", "reply", { text: "lo" }),
			)
			pokes.drop()
			await commitOnServer((tx) =>
				tx.append("messages", "reply", { text: "!" }),
			)
			const recovered = pokes.deliver()
			expect(client1.query({ collection: "messages" })).toEqual([reply("Hel")])
			await recovered
			expect(client1.query({ collection: "messages" })).toEqual([
				reply("Hello!"),
			])

			// A lost rewrite of the same length must not let the next append show
			// text the server never had.
			await commitOnServer((tx) => tx.set("messages", reply("Bye!!!")))
			pokes.drop()
			await commitOnServer((tx) =>
				tx.append("messages", "reply", { text: "?" }),
			)
			const rewritten = pokes.deliver()
			expect(client1.query({ collection: "messages" })).toEqual([
				reply("Hello!"),
			])
			await rewritten
			expect(client1.query({ collection: "messages" })).toEqual([
				reply("Bye!!!?"),
			])
		},
	)

	liveTest(
		"a live append extends the server's text under a pending local write",
		async ({ harness, pokes, commitOnServer }) => {
			const { client1 } = harness
			client1.subscribe({ collection: "messages" })
			await commitOnServer((tx) => tx.set("messages", reply("Hel")))
			await (
				await client1.pullFromRemote()
			).result
			pokes.drop()

			await harness.activateGates()
			const localTx = client1.transact()
			localTx.update("messages", "reply", { threadId: "thread-2" })
			const commit = await client1.commit(localTx)
			await commitOnServer((tx) =>
				tx.append("messages", "reply", { text: "lo" }),
			)
			void pokes.deliver()

			expect(client1.query({ collection: "messages" })).toEqual([
				{ ...reply("Hello"), threadId: "thread-2" },
			])
			await harness.deactivateGatesAndSettle()
			await commit.result
			await (
				await client1.pullFromRemote()
			).result
			expect(client1.query({ collection: "messages" })).toEqual([
				{ ...reply("Hello"), threadId: "thread-2" },
			])
		},
	)

	test("a restarted client ignores appends until its first pull", async ({
		makeRemote,
		makeStorage,
		logger,
		rng,
	}) => {
		const chat = makeRemote({
			schema: chatSchema,
			relations: chatRelations,
			livePokeInterval: 0,
		})
		const pokes = new HeldPokes(chat)
		const storage = makeStorage<ChatSchema>({ schema: chatSchema })
		const tx = chat.transact()
		tx.set("messages", reply("Hel"))
		await chat.commit(tx)

		const first = createClient({
			remote: pokes.remote,
			logger,
			rng,
			clientStorage: storage,
		})
		await first.ready
		await first.connect()
		first.subscribe({ collection: "messages" })
		await first.pullFromRemote()
		await first.flushClientStorage()

		// The first instance crashes without disconnecting, so the server keeps
		// its view and pokes the restarted instance with the same identity.
		const { promise: pullReleased, resolve: releasePull } =
			Promise.withResolvers<void>()
		const restarted = createClient({
			remote: {
				...pokes.remote,
				pull: async (args) => {
					await pullReleased
					return chat.pull(args)
				},
			},
			logger,
			rng,
			clientStorage: storage,
		})
		await restarted.ready
		restarted.subscribe({ collection: "messages" })
		const connected = restarted.connect()
		await vi.waitFor(() => expect(pokes.connections).toHaveLength(2))
		pokes.drop()
		const appendTx = chat.transact()
		appendTx.append("messages", "reply", { text: "lo" })
		await chat.commit(appendTx)
		const [, restartedPoke] = pokes.takePayloads()
		const pulled = pokes.connections[1]!.poke(restartedPoke)

		expect(restarted.query({ collection: "messages" })).toEqual([reply("Hel")])
		releasePull()
		await Promise.all([connected, pulled])
		expect(restarted.query({ collection: "messages" })).toEqual([
			reply("Hello"),
		])
		await first.disconnect()
		await restarted.disconnect()
	})

	liveTest(
		"pokes for a cleared client identity are ignored",
		async ({ harness, pokes }) => {
			const { client1 } = harness
			client1.subscribe({ collection: "messages" })
			const [previous] = pokes.connections
			await (
				await client1.clear()
			).result

			void previous!.poke({
				revision: { server: "server", commit: 1 },
				set: [{ collection: "messages", value: reply("Hel") }],
			})

			expect(client1.query({ collection: "messages" })).toEqual([])
		},
	)
})

/** Clients whose confirming pulls wait on timers the test controls. */
const deferralTest = serverTest.extend<{
	quiet: ManualTimer
	max: ManualTimer
	harness: ChatHarness
}>({
	quiet: async ({}, use) => {
		await use(new ManualTimer())
	},
	max: async ({}, use) => {
		await use(new ManualTimer())
	},
	harness: async ({ pokes, logger, rng, quiet, max }, use) => {
		await useConnectedHarness(
			pokes,
			(remote) =>
				createClient({
					remote,
					logger,
					rng,
					livePullDelay: quiet,
					livePullMaxDelay: max,
				}),
			use,
		)
	},
})

describe("confirming pulls during a live stream", () => {
	deferralTest(
		"payloads defer their pull until an interval passes without a new one",
		async ({ harness, pokes, quiet, commitOnServer }) => {
			const { client1 } = harness
			client1.subscribe({ collection: "messages" })
			await commitOnServer((tx) => tx.set("messages", reply("Hel")))
			await (
				await client1.pullFromRemote()
			).result
			pokes.drop()
			const pulls = pokes.pulls

			await commitOnServer((tx) =>
				tx.append("messages", "reply", { text: "lo" }),
			)
			const first = pokes.deliver()
			await commitOnServer((tx) =>
				tx.append("messages", "reply", { text: "!" }),
			)
			const second = pokes.deliver()

			// Another payload arrived during this interval, so the pull waits.
			await quiet.tick()
			expect(pokes.pulls).toBe(pulls)
			expect(client1.query({ collection: "messages" })).toEqual([
				reply("Hello!"),
			])

			// A quiet interval starts one pull that confirms both payloads.
			await quiet.tick()
			await Promise.all([first, second])
			expect(pokes.pulls).toBe(pulls + 1)
		},
	)

	deferralTest(
		"a stream that never goes quiet still pulls at the maximum delay",
		async ({ harness, pokes, quiet, max, commitOnServer }) => {
			const { client1 } = harness
			client1.subscribe({ collection: "messages" })
			await commitOnServer((tx) => tx.set("messages", reply("H")))
			await (
				await client1.pullFromRemote()
			).result
			pokes.drop()
			const pulls = pokes.pulls

			// Every interval sees a new payload.
			const delivered: Promise<void[]>[] = []
			for (const text of ["e", "l", "l", "o"]) {
				await commitOnServer((tx) => tx.append("messages", "reply", { text }))
				delivered.push(pokes.deliver())
				if (text !== "e") await quiet.tick()
			}
			expect(pokes.pulls).toBe(pulls)

			await max.tick()
			await Promise.all(delivered)
			expect(pokes.pulls).toBe(pulls + 1)
			expect(client1.query({ collection: "messages" })).toEqual([
				reply("Hello"),
			])
		},
	)

	deferralTest(
		"a bare poke, such as the pusher's acknowledgement, pulls at once and confirms deferred payloads",
		async ({ harness, pokes, commitOnServer }) => {
			const { client1 } = harness
			client1.subscribe({ collection: "messages" })
			await commitOnServer((tx) => tx.set("messages", reply("Hel")))
			await (
				await client1.pullFromRemote()
			).result
			pokes.drop()
			await commitOnServer((tx) =>
				tx.append("messages", "reply", { text: "lo" }),
			)
			const streamed = pokes.deliver()
			const pulls = pokes.pulls

			// The client writes mid-stream; its timers never fire.
			const tx = client1.transact()
			tx.set("messages", { ...reply("Mine"), id: "mine" })
			await (
				await client1.commit(tx)
			).result
			await pokes.deliver()
			await streamed

			expect(pokes.pulls).toBe(pulls + 1)
			expect(client1.query({ collection: "messages" })).toEqual([
				{ ...reply("Mine"), id: "mine" },
				reply("Hello"),
			])
		},
	)
})
