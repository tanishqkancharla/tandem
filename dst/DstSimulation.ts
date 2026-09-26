import "fake-indexeddb/auto"
import {
	Gatekeeper,
	type CallHandle,
	type PendingCall,
} from "@tanishqkancharla/gatekeeper"
import {
	collection,
	defineSchema,
	Logger,
	type RemoteApi,
	type RuntimeSchemaDefinition,
	t,
	TandemClient,
	type TimerApi,
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

/**
 * Registered as a Gatekeeper service with only its exit gate, so a tick is a
 * held handoff to its client rather than a real timeout.
 */
class DstTimer implements TimerApi {
	waitForNextTick(): Promise<void> {
		return Promise.resolve()
	}
}

const timerGates = { gates: { enter: false, exit: true } }

function isTimerHandoff({ sentBy, waitingFor }: PendingCall): boolean {
	return sentBy.endsWith("Timer") || waitingFor.endsWith("Timer")
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
		clientIds: readonly string[]
		converged: boolean
		finalCount: number
	}> {
		const logger = new Logger({ sinks: [] })
		const serverStorage = new InMemoryServerStorage()
		const server = new TandemServer<DstSchema, {}>({
			schema: dstSchemaDefinition,
			relations: {},
			storage: serverStorage,
			rng: this.rng.createRngApi("server"),
		})

		const rawClients: TandemClient<DstSchema>[] = []
		const createClient = (
			label: string,
			remote: RemoteApi<DstSchema>,
			timer: TimerApi,
		) => {
			const client = new TandemClient<DstSchema>({
				remote,
				schema: dstSchemaDefinition,
				logger,
				rng: this.rng.createRngApi(label),
				autoConnect: false,
				syncInterval: timer,
				clientStorageWriteInterval: timer,
			})
			rawClients.push(client)
			return client
		}

		const gatekeeper = new Gatekeeper()
			.add("server", () => new InProcessTransport(server))
			.add("client1Timer", () => new DstTimer(), timerGates)
			.add("client2Timer", () => new DstTimer(), timerGates)
			.add("client1", ({ server, client1Timer }) =>
				createClient("client1", server, client1Timer),
			)
			.add("client2", ({ server, client2Timer }) =>
				createClient("client2", server, client2Timer),
			)
			.build()

		// Initialize & connect clients
		for (const client of rawClients) {
			await client.ready
			await client.connect()
			client.subscribe({ collection: "todos" })
		}

		await gatekeeper.activateGates()

		const findPending = (handle: CallHandle<unknown>) =>
			gatekeeper.pendingCalls().find((pending) => pending.handle === handle)

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
					detail: { client: clientName, mutationId: tx.tupleDbTx.id, id },
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
					detail: { client: clientName, mutationId: tx.tupleDbTx.id, item },
				})
			}

			// In Gatekeeper, calling commit through the harness proxy returns a CallHandle
			const commitHandle = (await harnessClient.commit(
				tx,
			)) as unknown as CallHandle<void>

			const shouldInjectFault = faultRate > 0 && this.rng.boolean(faultRate)
			if (shouldInjectFault) {
				// Faults model lost network messages, so deliver this client's timer
				// ticks until the call is held at a handoff with the server.
				for (
					let pending = findPending(commitHandle);
					pending && isTimerHandoff(pending);
					pending = findPending(commitHandle)
				) {
					await commitHandle.continueTo(pending.waitingFor)
					this.trace.push({
						step,
						action: "DELIVER_TICK",
						detail: { client: clientName },
					})
				}

				const faultError = new Error(
					`Simulated Network/Push Fault at step ${step}`,
				)
				const boundary = findPending(commitHandle)
				this.trace.push({
					step,
					action: "INJECT_FAULT",
					detail: {
						client: clientName,
						sentBy: boundary?.sentBy,
						waitingFor: boundary?.waitingFor,
						error: faultError.message,
					},
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
			clientIds: rawClients.map((client) => client.clientId),
			converged,
			finalCount: client1State.length,
		}
	}
}
