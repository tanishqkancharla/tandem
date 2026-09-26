import "fake-indexeddb/auto"
import {
	Gatekeeper,
	type CallHandle,
	type GatekeeperEvents,
	type PendingCall,
} from "@tanishqkancharla/gatekeeper"
import {
	type ClientApi,
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
		this.server.connect(client)
	push: RemoteApi<DstSchema>["push"] = (args) => this.server.push(args)
	pull: RemoteApi<DstSchema>["pull"] = (args) => this.server.pull(args)
}

/**
 * A client's view of the server in which each poke arrives as a Gatekeeper
 * event owned by that client, so the run can deliver, delay, or drop it.
 */
function remoteWithPokeEvents(
	server: RemoteApi<DstSchema>,
	events: GatekeeperEvents,
): RemoteApi<DstSchema> {
	let poke: ClientApi["poke"] = () => Promise.resolve()
	const pokeEvent = events.on("poke", () => poke())
	return {
		connect: (client) => {
			poke = client.poke
			return server.connect({
				...client,
				poke: () => {
					pokeEvent.emit()
					return Promise.resolve()
				},
			})
		},
		push: (args) => server.push(args),
		pull: (args) => server.pull(args),
	}
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

const clientNames = ["client1", "client2"] as const
type DstClientName = (typeof clientNames)[number]

export type DstFinalStates = Record<"server" | DstClientName, DstTodo[]>

export type DstTraceRecord =
	| {
			type: "set"
			step: number
			client: DstClientName
			mutationId: string
			item: DstTodo
	  }
	| {
			type: "remove"
			step: number
			client: DstClientName
			mutationId: string
			id: string
	  }
	| { type: "deliverTick"; step: number; client: DstClientName }
	| {
			type: "fault"
			step: number
			client: DstClientName
			sentBy: string
			waitingFor: string
			error: string
	  }
	| { type: "complete"; step: number; client: DstClientName }

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
		states: DstFinalStates
		converged: boolean
	}> {
		const logger = new Logger({ sinks: [] })
		const serverStorage = new InMemoryServerStorage()
		const server = new TandemServer<DstSchema, {}>({
			schema: dstSchemaDefinition,
			relations: {},
			storage: serverStorage,
			rng: this.rng.createRngApi("server"),
		})

		const createClient = (
			label: DstClientName,
			remote: RemoteApi<DstSchema>,
			timer: TimerApi,
		) =>
			new TandemClient<DstSchema>({
				remote,
				schema: dstSchemaDefinition,
				logger,
				rng: this.rng.createRngApi(label),
				autoConnect: false,
				syncInterval: timer,
				clientStorageWriteInterval: timer,
			})

		await using gatekeeper = new Gatekeeper()
			.add("server", () => new InProcessTransport(server))
			.add("client1Timer", () => new DstTimer(), timerGates)
			.add("client2Timer", () => new DstTimer(), timerGates)
			.add("client1", ({ server, client1Timer }, { events }) =>
				createClient(
					"client1",
					remoteWithPokeEvents(server, events),
					client1Timer,
				),
			)
			.add("client2", ({ server, client2Timer }, { events }) =>
				createClient(
					"client2",
					remoteWithPokeEvents(server, events),
					client2Timer,
				),
			)
			.build()

		for (const name of clientNames) {
			const client = gatekeeper[name]
			await client.ready
			await (
				await client.connect()
			).result
			client.subscribe({ collection: "todos" })
			// subscribe returns synchronously but queues a pull inside its own call.
			// Finish that pull before gates activate, or it would try to add a
			// handoff to the completed subscribe call.
			await (
				await client.pullFromRemote()
			).result
		}

		await gatekeeper.activateGates()

		const findPending = (handle: CallHandle<unknown>) =>
			gatekeeper.pendingCalls().find((pending) => pending.handle === handle)

		const poolOfIds = ["item-1", "item-2", "item-3"]
		const faultRate = this.options.faultRate ?? 0

		for (let step = 0; step < this.options.steps; step++) {
			const clientName = this.rng.pick(clientNames)
			const client = gatekeeper[clientName]

			const id = this.rng.pick(poolOfIds)
			const isDelete = this.rng.boolean(0.2)

			const tx = client.transact()
			if (isDelete) {
				tx.remove("todos", id)
				this.trace.push({
					type: "remove",
					step,
					client: clientName,
					mutationId: tx.tupleDbTx.id,
					id,
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
					type: "set",
					step,
					client: clientName,
					mutationId: tx.tupleDbTx.id,
					item,
				})
			}

			const commit = await client.commit(tx)

			if (faultRate > 0 && this.rng.boolean(faultRate)) {
				// Faults model lost network messages, so deliver this client's timer
				// ticks until the call is held at a handoff with the server.
				let boundary = findPending(commit)
				while (boundary && isTimerHandoff(boundary)) {
					await commit.continueTo(boundary.waitingFor)
					this.trace.push({ type: "deliverTick", step, client: clientName })
					boundary = findPending(commit)
				}

				if (boundary) {
					const error = new Error(
						`Simulated Network/Push Fault at step ${step}`,
					)
					this.trace.push({
						type: "fault",
						step,
						client: clientName,
						sentBy: boundary.sentBy,
						waitingFor: boundary.waitingFor,
						error: error.message,
					})
					await commit.fail(error)
					await commit.result.catch(() => {})
					continue
				}
			}

			await commit.continueToCompletion()
			this.trace.push({ type: "complete", step, client: clientName })
		}

		await gatekeeper.deactivateGatesAndSettle()

		const byId = (a: DstTodo, b: DstTodo) => a.id.localeCompare(b.id)
		for (const name of clientNames) {
			await (
				await gatekeeper[name].pullFromRemote()
			).result
		}
		const states: DstFinalStates = {
			server: [...(await server.query({ collection: "todos" }))].sort(byId),
			client1: [
				...(gatekeeper.client1.query({ collection: "todos" }) as DstTodo[]),
			].sort(byId),
			client2: [
				...(gatekeeper.client2.query({ collection: "todos" }) as DstTodo[]),
			].sort(byId),
		}
		const serverState = JSON.stringify(states.server)
		const converged = clientNames.every(
			(name) => JSON.stringify(states[name]) === serverState,
		)
		const clientIds = clientNames.map((name) => gatekeeper[name].clientId)

		for (const name of clientNames) {
			await (
				await gatekeeper[name].disconnect()
			).result
		}
		await server.close()

		return {
			seed: this.options.seed,
			stepsCompleted: this.options.steps,
			trace: this.trace,
			clientIds,
			states,
			converged,
		}
	}
}
