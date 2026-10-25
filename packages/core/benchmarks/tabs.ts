/**
 * Shared-tab latency and channel traffic, in one Node process.
 *
 * pnpm --filter tandem-dst exec tsx ../packages/core/benchmarks/tabs.ts \
 *   [rows=100] [tabs=3] [samples=30] [networkDelayMs=5] [stable|churn]
 *
 * Uses fake-indexeddb, structured-clone channels, and a memory server with a
 * delayed push, so it compares implementations rather than predicting browser
 * or disk latency. The `churn` workload resubscribes the observing tab for
 * every sample.
 */
import "fake-indexeddb/auto"
import { performance } from "node:perf_hooks"
import { InMemoryTupleStorage } from "tuple-database"
import { TandemClient } from "../src/TandemClient.js"
import { collection, defineSchema, t } from "../src/index.js"
import { TandemClientIndexedDbStorage } from "../src/clientStorage/TandemClientIndexedDbStorage.js"
import {
	InMemoryTabs,
	type InMemoryTab,
	type TabEnvironmentApi,
} from "../src/tabs/TabEnvironment.js"
import { Logger } from "../src/utils/Logger.js"
import { TandemServer } from "../../server/src/TandemServer.js"
import type { TandemTuple } from "../../server/src/storage/TandemServerStorage.js"

type Schema = { items: { id: string; value: number; text: string } }

const rows = Number(process.argv[2] ?? 100)
const tabCount = Number(process.argv[3] ?? 3)
const samples = Number(process.argv[4] ?? 30)
const networkDelay = Number(process.argv[5] ?? 5)
const workload = process.argv[6] === "churn" ? "churn" : "stable"
const warmups = 3

const delay = (ms: number) =>
	new Promise<void>((resolve) => setTimeout(resolve, ms))
const memory = new InMemoryTupleStorage()
const logger = new Logger({ sinks: [] })
const server = new TandemServer<Schema, {}>({
	schema: defineSchema({
		items: collection({ id: t.id(), value: t.number(), text: t.string() }),
	}),
	relations: {},
	storage: {
		scan: async (args) => memory.scan(args) as TandemTuple<Schema>[],
		commit: async (writes) => {
			memory.commit(writes)
		},
		close: async () => {},
	},
})
const seedTx = server.transact()
for (let index = 0; index < rows; index++)
	seedTx.set("items", { id: String(index), value: 0, text: "x".repeat(80) })
await server.commit(seedTx)

const browser = new InMemoryTabs()
const clients: TandemClient<Schema>[] = []
const stores: TandemClientIndexedDbStorage<Schema>[] = []
const tabs: InMemoryTab[] = []
// Resolves when the server has applied the push carrying a sample's value.
const accepted = new Map<number, () => void>()
let messages = 0
let bytes = 0
for (let index = 0; index < tabCount; index++) {
	const tab = browser.openTab()
	tabs.push(tab)
	const environment: TabEnvironmentApi = {
		locks: tab.locks,
		openChannel(name) {
			const channel = tab.openChannel(name)
			return {
				postMessage(message) {
					messages++
					bytes += Buffer.byteLength(JSON.stringify(message))
					channel.postMessage(message)
				},
				addEventListener: (type, listener) =>
					channel.addEventListener(type, listener),
				removeEventListener: (type, listener) =>
					channel.removeEventListener(type, listener),
				close: () => channel.close(),
			}
		},
	}
	const storage = new TandemClientIndexedDbStorage<Schema>({
		dbName: `tabs-benchmark-${process.pid}`,
	})
	stores.push(storage)
	const client = new TandemClient<Schema>({
		logger,
		clientStorage: storage,
		clientStorageWriteInterval: 0,
		syncInterval: 0,
		tabs: { environment },
		remote: {
			connect: (api) => server.connect(api),
			pull: (args) => server.pull(args),
			push: async (args) => {
				await delay(networkDelay)
				const result = await server.push(args)
				if (!("error" in result))
					for (const mutation of args.mutations)
						for (const op of mutation.ops)
							if (op.type === "update" && op.payload.value !== undefined)
								accepted.get(op.payload.value)?.()
				return result
			},
		},
	})
	clients.push(client)
	await client.ready
	client.subscribe({ collection: "items" })
	await client.connect()
	await client.pullFromRemote()
}
await delay(25)

const writer = clients.at(-1)!
const observer = clients[0]!
const results = {
	/** Synchronous work inside commit(). */
	local: [] as number[],
	/** flushClientStorage() in the writing tab. */
	saved: [] as number[],
	/** The observing tab's subscription shows the edit. */
	observed: [] as number[],
	/** The server applied the push carrying the edit. */
	server: [] as number[],
	/** The public commit promise settled. */
	commit: [] as number[],
}
let expected = 0
let observedSample = () => {}
const stableSubscription =
	workload === "stable"
		? observer.subscribe(
				{ collection: "items", where: { id: "0" } },
				(items) => {
					if (items[0]?.value === expected) observedSample()
				},
			)
		: undefined
let startedMessages = messages
let startedBytes = bytes
for (let sample = 1; sample <= warmups + samples; sample++) {
	if (sample === warmups + 1) {
		for (const values of Object.values(results)) values.length = 0
		startedMessages = messages
		startedBytes = bytes
	}
	expected = sample
	const observed = Promise.withResolvers<void>()
	observedSample = observed.resolve
	const churnSubscription =
		workload === "churn"
			? observer.subscribe(
					{ collection: "items", where: { id: "0" } },
					(items) => {
						if (items[0]?.value === sample) observed.resolve()
					},
				)
			: undefined
	const serverApplied = Promise.withResolvers<void>()
	accepted.set(sample, serverApplied.resolve)

	const tx = writer.transact()
	tx.update("items", "0", { value: sample })
	const start = performance.now()
	const committed = writer.commit(tx)
	results.local.push(performance.now() - start)
	const elapsed = (list: number[]) => () => {
		list.push(performance.now() - start)
	}
	await Promise.all([
		committed.then(elapsed(results.commit)),
		writer.flushClientStorage().then(elapsed(results.saved)),
		observed.promise.then(elapsed(results.observed)),
		serverApplied.promise.then(elapsed(results.server)),
	])
	if (
		writer.query({ collection: "items", where: { id: "0" } })[0]?.value !==
		sample
	)
		throw new Error("Writer lost its edit")
	churnSubscription?.destroy()
	accepted.delete(sample)
}
stableSubscription?.destroy()

const percentile = (values: number[], fraction: number) => {
	const sorted = values.toSorted((a, b) => a - b)
	const index = Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))
	return Number(sorted[index]!.toFixed(3))
}
console.log(
	JSON.stringify(
		{
			rows,
			tabCount,
			samples,
			networkDelay,
			workload,
			latencyMs: Object.fromEntries(
				Object.entries(results).map(([name, values]) => [
					name,
					{ p50: percentile(values, 0.5), p95: percentile(values, 0.95) },
				]),
			),
			messages: messages - startedMessages,
			encodedBytes: bytes - startedBytes,
		},
		null,
		2,
	),
)
for (const client of clients.toReversed()) await client.close()
for (const tab of tabs) tab.close()
for (const storage of stores) await storage.close()
await server.close()
process.exit()
