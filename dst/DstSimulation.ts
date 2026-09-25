import "fake-indexeddb/auto"
import { Gatekeeper, type CallHandle } from "@tanishqkancharla/gatekeeper"
import {
	collection,
	defineSchema,
	Logger,
	type RemoteApi,
	type RuntimeSchemaDefinition,
	t,
	TandemClient,
} from "@tanishqkancharla/tandem-core"
import {
	TandemServer,
	type TandemServerStorageApi,
	type TandemTuple,
} from "@tanishqkancharla/tandem-server"
import asyncHooks from "node:async_hooks"
import {
	InMemoryTupleStorage,
	type ScanStorageArgs,
	type WriteOps,
} from "tuple-database"
import { SimPrng } from "./SimPrng.js"

export interface DstTodo {
	id: string
	text: string
	done: boolean
	priority: number
}

export type DstSchema = {
	todos: DstTodo
}

export const dstSchemaDefinition = defineSchema({
	todos: collection({
		id: t.id(),
		text: t.string(),
		done: t.boolean(),
		priority: t.number(),
	}),
}) satisfies RuntimeSchemaDefinition<DstSchema>

class InMemoryServerStorage implements TandemServerStorageApi<DstSchema> {
	private readonly memory = new InMemoryTupleStorage()

	scan(args?: ScanStorageArgs): Promise<TandemTuple<DstSchema>[]> {
		return Promise.resolve(this.memory.scan(args) as TandemTuple<DstSchema>[])
	}

	commit(writes: WriteOps<TandemTuple<DstSchema>>): Promise<void> {
		this.memory.commit(writes)
		return Promise.resolve()
	}

	close(): Promise<void> {
		this.memory.close()
		return Promise.resolve()
	}
}

class InProcessTransport implements RemoteApi<DstSchema> {
	constructor(private readonly server: RemoteApi<DstSchema>) {}

	connect: RemoteApi<DstSchema>["connect"] = (client) =>
		this.server.connect({
			...client,
			poke: asyncHooks.AsyncResource.bind(client.poke),
		})
	push: RemoteApi<DstSchema>["push"] = (args) => this.server.push(args)
	pull: RemoteApi<DstSchema>["pull"] = (args) => this.server.pull(args)
}

export interface DstRunOptions {
	seed: number
	steps: number
	faultRate?: number
}

export interface DstTraceRecord {
	step: number
	action: string
	detail?: Record<string, unknown>
}

export class DstSimulation {
	readonly rng: SimPrng
	readonly trace: DstTraceRecord[] = []

	constructor(private readonly options: DstRunOptions) {
		this.rng = new SimPrng(options.seed)
	}

	async execute(): Promise<{
		seed: number
		stepsCompleted: number
		trace: readonly DstTraceRecord[]
		converged: boolean
		finalCount: number
	}> {
		const logger = new Logger({ sinks: [] })
		const serverStorage = new InMemoryServerStorage()
		const server = new TandemServer<DstSchema, {}>({
			schema: dstSchemaDefinition,
			relations: {},
			storage: serverStorage,
		})

		const rawClients: TandemClient<DstSchema>[] = []

		const gatekeeper = new Gatekeeper()
			.add("server", () => new InProcessTransport(server))
			.add("client1", ({ server }) => {
				const client = new TandemClient<DstSchema>({
					remote: server,
					schema: dstSchemaDefinition,
					logger,
					autoConnect: false,
					syncInterval: 0,
				})
				rawClients.push(client)
				return client
			})
			.add("client2", ({ server }) => {
				const client = new TandemClient<DstSchema>({
					remote: server,
					schema: dstSchemaDefinition,
					logger,
					autoConnect: false,
					syncInterval: 0,
				})
				rawClients.push(client)
				return client
			})
			.build()

		// Initialize & connect clients
		for (const client of rawClients) {
			await client.ready
			await client.connect()
			client.subscribe({ collection: "todos" })
		}

		await gatekeeper.activateGates()

		const poolOfIds = ["item-1", "item-2", "item-3"]
		const faultRate = this.options.faultRate ?? 0

		for (let step = 0; step < this.options.steps; step++) {
			const isClient1 = this.rng.boolean(0.5)
			const harnessClient = isClient1 ? gatekeeper.client1 : gatekeeper.client2
			const rawClient = isClient1 ? rawClients[0] : rawClients[1]
			const clientName = isClient1 ? "client1" : "client2"

			const id = this.rng.pick(poolOfIds)
			const isDelete = this.rng.boolean(0.2)

			const tx = rawClient.transact()
			if (isDelete) {
				tx.remove("todos", id)
				this.trace.push({
					step,
					action: "MUTATION_DELETE",
					detail: { client: clientName, id },
				})
			} else {
				const item: DstTodo = {
					id,
					text: `Note ${id} (rev ${step})`,
					done: this.rng.boolean(0.3),
					priority: this.rng.int(1, 5),
				}
				tx.set("todos", item)
				this.trace.push({
					step,
					action: "MUTATION_SET",
					detail: { client: clientName, item },
				})
			}

			// In Gatekeeper, calling commit through the harness proxy returns a CallHandle
			const commitHandle = (await harnessClient.commit(
				tx,
			)) as unknown as CallHandle<void>

			const shouldInjectFault = faultRate > 0 && this.rng.boolean(faultRate)
			if (shouldInjectFault) {
				const faultError = new Error(
					`Simulated Network/Push Fault at step ${step}`,
				)
				this.trace.push({
					step,
					action: "INJECT_FAULT",
					detail: { client: clientName, error: faultError.message },
				})
				await commitHandle.fail(faultError)
				// Catch the expected rejection
				await commitHandle.result.catch(() => {})
			} else {
				// Deterministic advancement: complete this call through the gates
				await commitHandle.continueToCompletion()
				this.trace.push({
					step,
					action: "STEP_COMPLETE",
					detail: { client: clientName },
				})
			}
		}

		// --- PHASE 2: Quiesce & Converge ---
		await gatekeeper.deactivateGatesAndSettle()

		// Ensure both clients pull latest changes from the server
		await (
			await gatekeeper.client1.pullFromRemote()
		).result
		await (
			await gatekeeper.client2.pullFromRemote()
		).result

		// Verify Invariants: Eventual Consistency between both clients
		const client1State = (
			rawClients[0].query({ collection: "todos" }) as DstTodo[]
		).sort((a, b) => a.id.localeCompare(b.id))
		const client2State = (
			rawClients[1].query({ collection: "todos" }) as DstTodo[]
		).sort((a, b) => a.id.localeCompare(b.id))

		const converged =
			JSON.stringify(client1State) === JSON.stringify(client2State)

		// Teardown
		for (const client of rawClients) {
			await client.disconnect()
		}
		await server.close()

		return {
			seed: this.options.seed,
			stepsCompleted: this.options.steps,
			trace: this.trace,
			converged,
			finalCount: client1State.length,
		}
	}
}
