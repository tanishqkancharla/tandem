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
	type SchemaToTupleSchema,
	TandemClient,
	type TandemClientStorageApi,
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

type DstClientTuple = SchemaToTupleSchema<DstSchema>

function roundTrip<Value>(value: Value): Value {
	return JSON.parse(JSON.stringify(value)) as Value
}

/**
 * A client's durable storage. It is its own Gatekeeper service, so it outlives
 * the client's crashes and each write is a handoff the run can order. Values
 * round-trip through JSON, as they would through a real store.
 */
class DstClientStorage implements TandemClientStorageApi<DstSchema> {
	private readonly memory = new InMemoryTupleStorage()

	scan(args?: ScanStorageArgs): Promise<DstClientTuple[]> {
		return Promise.resolve(
			roundTrip(this.memory.scan(args)) as DstClientTuple[],
		)
	}

	commit(writes: WriteOps<DstClientTuple>): Promise<void> {
		this.memory.commit(roundTrip(writes))
		return Promise.resolve()
	}

	close(): Promise<void> {
		return Promise.resolve()
	}

	clear(): Promise<void> {
		this.memory.commit({ remove: this.memory.scan().map(({ key }) => key) })
		return Promise.resolve()
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
	/** Chance per step that a running client crashes. */
	crashRate?: number
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
	| { type: "crash"; step: number; client: DstClientName }
	| { type: "restart"; step: number; client: DstClientName; clientId: string }

/** A new mutation starts only while fewer calls than this are in flight. */
const maxCallsInFlight = 4
/** How often a step starts a mutation rather than advancing a pending call. */
const mutateRate = 0.35
/** Chance per step that a crashed client restarts. */
const restartRate = 0.25

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

		// A restart runs this again, so each incarnation gets a fresh rng stream.
		const createClient = (
			label: DstClientName,
			remote: RemoteApi<DstSchema>,
			timer: TimerApi,
			storage: TandemClientStorageApi<DstSchema>,
		) => {
			const client = new TandemClient<DstSchema>({
				remote,
				clientStorage: storage,
				schema: dstSchemaDefinition,
				logger,
				rng: this.rng.createRngApi(label),
				autoConnect: false,
				syncInterval: timer,
				clientStorageWriteInterval: timer,
			})
			// The app subscribes at startup. Until it connects, the pull this
			// queues is a no-op, so the first real pull runs inside connect.
			client.subscribe({ collection: "todos" })
			return client
		}

		await using gatekeeper = new Gatekeeper()
			.add("server", () => new InProcessTransport(server))
			.add("client1Timer", () => new DstTimer(), timerGates)
			.add("client2Timer", () => new DstTimer(), timerGates)
			.add("client1Storage", () => new DstClientStorage())
			.add("client2Storage", () => new DstClientStorage())
			.add("client1", ({ server, client1Timer, client1Storage }, { events }) =>
				createClient(
					"client1",
					remoteWithPokeEvents(server, events),
					client1Timer,
					client1Storage,
				),
			)
			.add("client2", ({ server, client2Timer, client2Storage }, { events }) =>
				createClient(
					"client2",
					remoteWithPokeEvents(server, events),
					client2Timer,
					client2Storage,
				),
			)
			.build()

		const crashed = new Set<DstClientName>()
		// Counts restarts, so work begun for an earlier incarnation stops.
		const generations: Record<DstClientName, number> = {
			client1: 0,
			client2: 0,
		}
		// The generation whose storage has loaded, so it can take writes.
		const loaded = new Map<DstClientName, number>()
		// Clients whose latest connect was lost; they reconnect at quiescence.
		const unconnected = new Set<DstClientName>()
		const boot = async (name: DstClientName) => {
			const generation = generations[name]
			const current = () =>
				!crashed.has(name) && generations[name] === generation
			await gatekeeper[name].ready
			if (!current()) return
			loaded.set(name, generation)
			const connect = await gatekeeper[name].connect()
			unconnected.delete(name)
			await connect.result.catch((error: unknown) => {
				if (!current()) return
				// A dropped connect or first pull leaves the client offline, as a
				// real network would, until it reconnects at quiescence.
				if (!(error instanceof DstFaultError)) throw error
				unconnected.add(name)
			})
		}

		for (const name of clientNames) await boot(name)

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

		const mutate = (step: number, writers: readonly DstClientName[]) => {
			const clientName = this.rng.pick(writers)
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
		const crashRate = this.options.crashRate ?? 0
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
			// Without crashes these draw nothing, so crash-free runs are unchanged.
			const down = clientNames.filter((name) => crashed.has(name))
			const running = clientNames.filter((name) => !crashed.has(name))
			const writers = running.filter(
				(name) => loaded.get(name) === generations[name],
			)

			if (down.length > 0 && this.rng.boolean(restartRate)) {
				const name = this.rng.pick(down)
				crashed.delete(name)
				generations[name] += 1
				await gatekeeper.restart(name)
				this.trace.push({
					type: "restart",
					step,
					client: name,
					clientId: gatekeeper[name].clientId,
				})
				inFlight.push(boot(name))
			} else if (
				crashRate > 0 &&
				running.length > 0 &&
				this.rng.boolean(crashRate)
			) {
				const name = this.rng.pick(running)
				crashed.add(name)
				loaded.delete(name)
				await gatekeeper.crash(name)
				this.trace.push({ type: "crash", step, client: name })
			} else if (
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
				writers.length > 0 &&
				(pending.length === 0 ||
					(pending.length < maxCallsInFlight && this.rng.boolean(mutateRate)))
			) {
				mutate(step, writers)
			} else if (pending.length > 0) {
				const target = this.rng.pick(pending)
				this.trace.push({ type: "advance", step, ...boundary(target) })
				deliveredEvents.add(target.handle)
				inFlight.push(target.handle.continueTo(target.waitingFor))
			}
			await settle()
		}

		await gatekeeper.deactivateGatesAndSettle()
		await Promise.all(inFlight)
		for (const name of clientNames) {
			if (!crashed.has(name)) continue
			crashed.delete(name)
			generations[name] += 1
			await gatekeeper.restart(name)
			await boot(name)
		}
		for (const name of unconnected) {
			await (
				await gatekeeper[name].connect()
			).result
		}

		const byId = (a: DstTodo, b: DstTodo) => a.id.localeCompare(b.id)
		for (const name of clientNames) {
			await (
				await gatekeeper[name].pullFromRemote()
			).result
		}
		const states: DstFinalStates = {
			server: [...(await server.query({ collection: "todos" }))].sort(byId),
			client1: [...gatekeeper.client1.query({ collection: "todos" })].sort(
				byId,
			),
			client2: [...gatekeeper.client2.query({ collection: "todos" })].sort(
				byId,
			),
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
