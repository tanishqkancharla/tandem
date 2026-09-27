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
import * as errore from "errore"
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

/** Where a dropped handoff was lost, which decides what its sender can know. */
export type DstFaultKind =
	/** The receiver never saw the request. */
	| "requestLost"
	/** The receiver processed the request, but its reply never arrived. */
	| "responseLost"
	/** A server poke never reached its client. */
	| "pokeLost"

export class DstFaultError extends errore.createTaggedError({
	name: "DstFaultError",
	message: "$call: $kind",
}) {}

type DstBoundary = { call: string; sentBy: string; waitingFor: string }

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
	| ({ type: "advance"; step: number } & DstBoundary)
	| ({ type: "drop"; step: number; fault: DstFaultKind } & DstBoundary)

/** A new mutation starts only while fewer calls than this are in flight. */
const maxCallsInFlight = 4
/** How often a step starts a mutation rather than advancing a pending call. */
const mutateRate = 0.35

function faultKind(
	{ label, waitingFor }: PendingCall,
	eventDelivered: boolean,
): DstFaultKind {
	// A poke call first stops at the poke itself; after delivery its boundaries
	// belong to the pull the poke started.
	if (label.endsWith(".poke") && !eventDelivered) return "pokeLost"
	return waitingFor === "server" ? "requestLost" : "responseLost"
}

/** Lets promise continuations settle so the next step sees stable boundaries. */
function settle(): Promise<void> {
	return new Promise((resolve) => setImmediate(resolve))
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
		states: DstFinalStates
		converged: boolean
		maxPendingCalls: number
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

		const callNames = new Map<CallHandle<unknown>, string>()
		const deliveredEvents = new Set<CallHandle<unknown>>()
		const labelCounts = new Map<string, number>()
		const nameCall = (pending: PendingCall): string => {
			const existing = callNames.get(pending.handle)
			if (existing) return existing
			const count = (labelCounts.get(pending.label) ?? 0) + 1
			labelCounts.set(pending.label, count)
			const name = `${pending.label}#${count}`
			callNames.set(pending.handle, name)
			return name
		}
		const boundary = (pending: PendingCall): DstBoundary => ({
			call: nameCall(pending),
			sentBy: pending.sentBy,
			waitingFor: pending.waitingFor,
		})

		const mutate = (step: number) => {
			const clientName = this.rng.pick(clientNames)
			const client = gatekeeper[clientName]
			const id = this.rng.pick(poolOfIds)
			const tx = client.transact()
			if (this.rng.boolean(0.2)) {
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
			// The handle arrives only once the commit reaches a boundary, which may
			// wait on another held call. Its call shows up in pendingCalls() then.
			inFlight.push(client.commit(tx))
		}

		const poolOfIds = ["item-1", "item-2", "item-3"]
		const faultRate = this.options.faultRate ?? 0
		// Controls resolve when their call reaches its next boundary, which can
		// depend on other held calls, so a step starts them without waiting.
		const inFlight: Promise<unknown>[] = []
		let maxPendingCalls = 0

		for (let step = 0; step < this.options.steps; step++) {
			const pending = gatekeeper.pendingCalls()
			// Name calls in creation order so trace names do not depend on choices.
			for (const call of pending) nameCall(call)
			maxPendingCalls = Math.max(maxPendingCalls, pending.length)
			// Faults model lost network messages, never a timer that fails to tick.
			const droppable = pending.filter((call) => !isTimerHandoff(call))

			if (
				faultRate > 0 &&
				droppable.length > 0 &&
				this.rng.boolean(faultRate)
			) {
				const target = this.rng.pick(droppable)
				const kind = faultKind(target, deliveredEvents.has(target.handle))
				const record = boundary(target)
				this.trace.push({ type: "drop", step, fault: kind, ...record })
				inFlight.push(
					target.handle.fail(new DstFaultError({ call: record.call, kind })),
				)
			} else if (
				pending.length === 0 ||
				(pending.length < maxCallsInFlight && this.rng.boolean(mutateRate))
			) {
				mutate(step)
			} else {
				const target = this.rng.pick(pending)
				this.trace.push({ type: "advance", step, ...boundary(target) })
				deliveredEvents.add(target.handle)
				inFlight.push(target.handle.continueTo(target.waitingFor))
			}
			await settle()
		}

		await gatekeeper.deactivateGatesAndSettle()
		await Promise.all(inFlight)

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
			maxPendingCalls,
		}
	}
}
