import {
	Gatekeeper,
	GatekeeperError,
	type CallHandle,
	type GatekeeperEvents,
	type Harness,
	type PendingCall,
} from "@tanishqkancharla/gatekeeper"
import {
	type ClientApi,
	type PokePayload,
	collection,
	defineSchema,
	Logger,
	type RemoteApi,
	type RngApi,
	type RuntimeSchemaDefinition,
	t,
	type TandemClientTuple,
	TandemClient,
	type TandemClientStorageApi,
	type TimerApi,
	unreachable,
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

/** Records only the server writes, as an agent's reply would be. */
export const serverOwnedIds = ["reply-1", "reply-2"]

class InMemoryServerStorage implements TandemServerStorageApi<DstSchema> {
	private readonly memory = new InMemoryTupleStorage()

	/** Every value each server-owned record has had, in commit order; null when absent. */
	readonly history = new Map(serverOwnedIds.map((id) => [id, ["null"]]))

	scan(args?: ScanStorageArgs): Promise<TandemTuple<DstSchema>[]> {
		return Promise.resolve(this.memory.scan(args) as TandemTuple<DstSchema>[])
	}

	commit(writes: WriteOps<TandemTuple<DstSchema>>): Promise<void> {
		this.memory.commit(writes)
		for (const { key, value } of writes.set ?? []) {
			if (key[0] === "record")
				this.history.get(key[2])?.push(JSON.stringify(value))
		}
		for (const key of writes.remove ?? []) {
			if (key[0] === "record") this.history.get(key[2])?.push("null")
		}
		return Promise.resolve()
	}

	close(): Promise<void> {
		this.memory.close()
		return Promise.resolve()
	}
}

/**
 * A client's view of the server in which each poke arrives as a Gatekeeper
 * event owned by that client, so the run can deliver, delay, or drop it.
 */
function remoteWithPokeEvents(
	server: RemoteApi<DstSchema>,
	events: GatekeeperEvents,
): RemoteApi<DstSchema> {
	let poke: ClientApi<DstSchema>["poke"] = () => Promise.resolve()
	const pokeEvent = events.on<PokePayload<DstSchema> | undefined>(
		"poke",
		(payload) => poke(payload),
	)
	return {
		connect: (client) => {
			poke = client.poke
			return server.connect({
				...client,
				poke: (payload) => {
					// Payloads cross the network as JSON.
					pokeEvent.emit(payload && roundTrip(payload))
					return Promise.resolve()
				},
			})
		},
		push: (args) => server.push(args),
		pull: (args) => server.pull(args),
	}
}

type DstClientTuple = TandemClientTuple<DstSchema>

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

/**
 * A handoff that crosses the network: a request to the server, its reply, or a
 * poke. Timer ticks and storage writes are local, so a fault never drops them.
 */
export function isNetworkHandoff({ sentBy, waitingFor }: PendingCall): boolean {
	return sentBy === "server" || waitingFor === "server"
}

export type DstClientName = `client${number}`

/** Each participant's todos when the run ended; null for a client that was down. */
export type DstFinalStates = Record<"server", DstTodo[]> &
	Record<DstClientName, DstTodo[] | null>

export type DstViolation =
	/** A settled client's subscribed view differs from the authoritative server. */
	| {
			kind: "clientState"
			step: "quiescence"
			client: DstClientName
			expected: DstTodo[]
			actual: DstTodo[]
	  }
	/**
	 * A client showed a server-owned record older than one it showed before,
	 * or a value the server never had.
	 */
	| {
			kind: "movedBackwards"
			step: number
			client: DstClientName
			id: string
			shown: DstTodo | null
			previous: DstTodo | null
	  }

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

class DstCommitError extends errore.createTaggedError({
	name: "DstCommitError",
	message: "$client commit failed",
}) {}

export type DstBoundary = { call: string; sentBy: string; waitingFor: string }

export type DstTraceRecord =
	| {
			type: "set"
			step: number
			client: DstClientName
			mutationId: number
			item: DstTodo
	  }
	| {
			type: "update"
			step: number
			client: DstClientName
			mutationId: number
			id: string
			payload: Partial<Omit<DstTodo, "id">>
	  }
	| {
			type: "remove"
			step: number
			client: DstClientName
			mutationId: number
			id: string
	  }
	| ({ type: "advance"; step: number } & DstBoundary)
	| ({ type: "drop"; step: number; fault: DstFaultKind } & DstBoundary)
	| { type: "serverSet"; step: number; item: DstTodo }
	| { type: "serverRemove"; step: number; id: string }
	| { type: "crash"; step: number; client: DstClientName }
	| { type: "restart"; step: number; client: DstClientName; clientId: string }

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

/** A change the run applies in one step; its trace record adds what it observed. */
export type DstIntent =
	| { type: "set"; client: DstClientName; item: DstTodo }
	| {
			type: "update"
			client: DstClientName
			id: string
			payload: Partial<Omit<DstTodo, "id">>
	  }
	| { type: "remove"; client: DstClientName; id: string }
	/** The server writes on its own, as an agent saving its reply would. */
	| { type: "serverSet"; item: DstTodo }
	| { type: "serverRemove"; id: string }
	| { type: "advance"; call: string }
	| { type: "drop"; call: string }
	| { type: "crash"; client: DstClientName }
	| { type: "restart"; client: DstClientName }

/** A call held at a boundary, with its stable trace name. */
export type DstPendingCall = PendingCall & { name: string }

export type DstOutcome = {
	violation: DstViolation | undefined
	states: DstFinalStates
	clientIds: readonly (string | null)[]
}

/**
 * The simulated system: a server, clients with timers and durable storage,
 * and the Gatekeeper harness that orders their handoffs.
 * A random run and a replay drive it through the same events.
 */
export class DstWorld implements AsyncDisposable {
	private readonly crashed = new Set<DstClientName>()
	// Counts restarts, so work begun for an earlier incarnation stops.
	private readonly generations: Record<DstClientName, number>
	// The generation whose storage has loaded, so it can take writes.
	private readonly loaded = new Map<DstClientName, number>()
	// Trace IDs only; correctness does not depend on tracking every mutation.
	private readonly writeCounts = new Map<DstClientName, number>()
	private readonly callNames = new Map<CallHandle<unknown>, string>()
	private readonly labelCounts = new Map<string, number>()
	private readonly deliveredEvents = new Set<CallHandle<unknown>>()
	// Count commits through their result, not just until their first held handoff.
	private activeMutations = 0
	// Controls resolve when their call reaches its next boundary, which can
	// depend on other held calls, so a step starts them without waiting.
	private readonly inFlight: Promise<unknown>[] = []
	private held: readonly DstPendingCall[] = []
	// The server history index of the last value each client showed per
	// server-owned record. A restart may show older synced values, so it resets.
	private readonly shown = new Map<string, number>()
	private lastStep = -1
	private orderViolation: DstViolation | undefined
	maxPendingCalls = 0
	maxMutationsInFlight = 0

	readonly clientNames: readonly DstClientName[]
	private readonly server: TandemServer<DstSchema, {}>
	private readonly harness: DstHarness
	private readonly storage: InMemoryServerStorage

	private constructor({
		server,
		harness,
		clientNames,
		storage,
	}: {
		server: TandemServer<DstSchema, {}>
		harness: DstHarness
		clientNames: readonly DstClientName[]
		storage: InMemoryServerStorage
	}) {
		this.server = server
		this.harness = harness
		this.clientNames = clientNames
		this.storage = storage
		this.generations = Object.fromEntries(clientNames.map((name) => [name, 0]))
	}

	static async start({
		seed,
		clientCount = 2,
	}: {
		seed: number
		clientCount?: number
	}): Promise<DstWorld> {
		const clientNames = Array.from(
			{ length: clientCount },
			(_, index): DstClientName => `client${index + 1}`,
		)
		const storage = new InMemoryServerStorage()
		const server = new TandemServer<DstSchema, {}>({
			schema: dstSchemaDefinition,
			relations: {},
			storage,
			rng: SimPrng.idSource(seed, "server"),
		})
		let world: DstWorld | undefined
		const harness = buildHarness({
			server,
			clientNames,
			// A restart runs the factory again with the next generation's ids.
			idSource: (label) =>
				SimPrng.idSource(seed, `${label}.${world?.generations[label] ?? 0}`),
		})
		world = new DstWorld({ server, storage, harness, clientNames })
		for (const name of clientNames) await world.boot(name)
		await harness.activateGates()
		return world
	}

	get running(): readonly DstClientName[] {
		return this.clientNames.filter((name) => !this.crashed.has(name))
	}

	get down(): readonly DstClientName[] {
		return this.clientNames.filter((name) => this.crashed.has(name))
	}

	get mutationsInFlight(): number {
		return this.activeMutations
	}

	/** Running clients whose storage has loaded, so they can take writes. */
	get writers(): readonly DstClientName[] {
		return this.running.filter(
			(name) => this.loaded.get(name) === this.generations[name],
		)
	}

	/** Calls held at a boundary, named in creation order so names never depend on choices. */
	pending(): readonly DstPendingCall[] {
		this.held = this.harness
			.pendingCalls()
			.map((call) => ({ ...call, name: this.nameCall(call) }))
		this.maxPendingCalls = Math.max(this.maxPendingCalls, this.held.length)
		return this.held
	}

	/** Applies one event and returns its trace record. */
	async apply(step: number, intent: DstIntent): Promise<DstTraceRecord> {
		this.lastStep = step
		switch (intent.type) {
			case "set":
			case "update":
			case "remove":
				return this.write(step, intent)
			case "serverSet":
			case "serverRemove":
				return this.writeOnServer(step, intent)
			case "advance": {
				const target = this.find(intent.call)
				this.deliveredEvents.add(target.handle)
				this.inFlight.push(target.handle.continueTo(target.waitingFor))
				return { type: "advance", step, ...boundaryOf(target) }
			}
			case "drop": {
				const target = this.find(intent.call)
				const kind = faultKind(target, this.deliveredEvents.has(target.handle))
				this.inFlight.push(
					target.handle.fail(new DstFaultError({ call: target.name, kind })),
				)
				return { type: "drop", step, fault: kind, ...boundaryOf(target) }
			}
			case "crash":
				this.crashed.add(intent.client)
				this.loaded.delete(intent.client)
				this.writeCounts.delete(intent.client)
				await this.harness.crash(intent.client)
				return { type: "crash", step, client: intent.client }
			case "restart": {
				this.crashed.delete(intent.client)
				this.generations[intent.client] += 1
				await this.harness.restart(intent.client)
				this.inFlight.push(this.boot(intent.client))
				return {
					type: "restart",
					step,
					client: intent.client,
					clientId: this.harness[intent.client].clientId,
				}
			}
		}
	}

	hasPending(call: string): boolean {
		return this.held.some(({ name }) => name === call)
	}

	/** Let continuations reach their next boundary before choosing another event. */
	async settle(): Promise<void> {
		await settle()
		this.observeOrder()
	}

	/** Each client's server-owned records only move forward through server history. */
	private observeOrder() {
		for (const name of this.clientNames) {
			if (this.loaded.get(name) !== this.generations[name]) {
				for (const id of serverOwnedIds) this.shown.delete(`${name}:${id}`)
				continue
			}
			const todos = this.todosOf(name)
			for (const id of serverOwnedIds) {
				const history = this.storage.history.get(id)!
				const previous = this.shown.get(`${name}:${id}`) ?? 0
				const todo = todos.find((candidate) => candidate.id === id)
				const index = history.indexOf(JSON.stringify(todo ?? null), previous)
				if (index !== -1) {
					this.shown.set(`${name}:${id}`, index)
					continue
				}
				this.orderViolation ??= {
					kind: "movedBackwards",
					step: this.lastStep,
					client: name,
					id,
					shown: todo ?? null,
					previous: JSON.parse(history[previous]!) as DstTodo | null,
				}
			}
		}
	}

	/**
	 * Stop injecting faults, finish retained writes over healthy connections,
	 * then pull every client and compare its subscribed view with the server.
	 */
	async finish(): Promise<DstOutcome> {
		await this.drain()

		for (const name of this.down) {
			this.crashed.delete(name)
			this.generations[name] += 1
			await this.harness.restart(name)
			await this.boot(name)
		}
		for (const name of this.clientNames) {
			await (
				await this.harness[name].disconnect()
			).result
			await (
				await this.harness[name].connect()
			).result
		}
		await this.drain()
		for (const name of this.clientNames) {
			await (
				await this.harness[name].pullFromRemote()
			).result
		}
		await this.drain()

		const states: DstFinalStates = {
			server: await this.serverTodos(),
			...Object.fromEntries(
				this.clientNames.map((name) => [
					name,
					this.crashed.has(name) ? null : this.todosOf(name),
				]),
			),
		}
		const client = this.clientNames.find(
			(name) => JSON.stringify(states[name]) !== JSON.stringify(states.server),
		)
		const violation: DstViolation | undefined =
			this.orderViolation ??
			(client
				? {
						kind: "clientState",
						step: "quiescence",
						client,
						expected: states.server,
						actual: this.todosOf(client),
					}
				: undefined)
		const clientIds = this.clientNames.map((name) =>
			this.crashed.has(name) ? null : this.harness[name].clientId,
		)
		for (const name of this.running) {
			await (
				await this.harness[name].disconnect()
			).result
		}
		return { violation, states, clientIds }
	}

	/** Releases every gate and lets all work in flight finish. */
	async drain(): Promise<void> {
		await this.harness.deactivateGatesAndSettle()
		const results = await Promise.all(this.inFlight)
		const error = results.find((result) => result instanceof Error)
		if (error instanceof Error) throw error
	}

	async [Symbol.asyncDispose](): Promise<void> {
		await this.harness[Symbol.asyncDispose]()
		await this.server.close()
	}

	private write(
		step: number,
		intent: Extract<DstIntent, { type: "set" | "update" | "remove" }>,
	): DstTraceRecord {
		const client = this.harness[intent.client]
		const tx = client.transact()
		switch (intent.type) {
			case "set":
				tx.set("todos", intent.item)
				break
			case "update":
				tx.update("todos", intent.id, intent.payload)
				break
			case "remove":
				tx.remove("todos", intent.id)
				break
			default:
				return unreachable(intent)
		}
		const mutationId = (this.writeCounts.get(intent.client) ?? 0) + 1
		this.writeCounts.set(intent.client, mutationId)
		const generation = this.generations[intent.client]
		this.activeMutations += 1
		this.maxMutationsInFlight = Math.max(
			this.maxMutationsInFlight,
			this.mutationsInFlight,
		)
		// The handle arrives only once the commit reaches a boundary, which may
		// wait on another held call. Its call shows up in pending() then.
		this.inFlight.push(
			client.commit(tx).then(async (handle) => {
				const result = await handle.result.catch(
					(cause: unknown) =>
						new DstCommitError({ client: intent.client, cause }),
				)
				this.activeMutations -= 1
				if (result instanceof Error) {
					// Faults and terminated incarnations are already recorded in the trace.
					if (
						result.cause instanceof DstFaultError ||
						(result.cause instanceof GatekeeperError &&
							(this.crashed.has(intent.client) ||
								this.generations[intent.client] !== generation))
					)
						return
					return result
				}
			}),
		)
		return { ...intent, step, mutationId }
	}

	private writeOnServer(
		step: number,
		intent: Extract<DstIntent, { type: "serverSet" | "serverRemove" }>,
	): DstTraceRecord {
		const tx = this.harness.server.transact()
		if (intent.type === "serverSet") tx.set("todos", intent.item)
		else tx.remove("todos", intent.id)
		// Its pokes, with the records each client views, are events the run can lose.
		this.inFlight.push(this.harness.server.commit(tx))
		return { ...intent, step }
	}

	private async boot(name: DstClientName): Promise<void> {
		const generation = this.generations[name]
		const current = () =>
			!this.crashed.has(name) && this.generations[name] === generation
		await this.harness[name].ready
		if (!current()) return
		this.loaded.set(name, generation)
		const connect = await this.harness[name].connect()
		await connect.result.catch((error: unknown) => {
			if (!current()) return
			// A dropped connect or first pull leaves the client offline, as a
			// real network would, until it reconnects at quiescence.
			if (!(error instanceof DstFaultError)) throw error
			// All clients reconnect over a healthy transport during finish().
		})
	}

	private nameCall(pending: PendingCall): string {
		const existing = this.callNames.get(pending.handle)
		if (existing) return existing
		const count = (this.labelCounts.get(pending.label) ?? 0) + 1
		this.labelCounts.set(pending.label, count)
		const name = `${pending.label}#${count}`
		this.callNames.set(pending.handle, name)
		return name
	}

	private find(call: string): DstPendingCall {
		const target = this.held.find(({ name }) => name === call)
		if (!target) throw new Error(`${call} is not held at a boundary`)
		return target
	}

	todosOf(name: DstClientName): DstTodo[] {
		return [...this.harness[name].query({ collection: "todos" })].sort(byId)
	}

	private async serverTodos(): Promise<DstTodo[]> {
		return [...(await this.server.query({ collection: "todos" }))].sort(byId)
	}
}

function byId(a: DstTodo, b: DstTodo): number {
	return a.id.localeCompare(b.id)
}

function boundaryOf(call: DstPendingCall): DstBoundary {
	return { call: call.name, sentBy: call.sentBy, waitingFor: call.waitingFor }
}

function buildHarness({
	server,
	clientNames,
	idSource,
}: {
	server: TandemServer<DstSchema, {}>
	clientNames: readonly DstClientName[]
	idSource: (label: DstClientName) => RngApi
}) {
	const logger = new Logger({ sinks: [] })
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
			rng: idSource(label),
			autoConnect: false,
			syncInterval: timer,
			clientStorageWriteInterval: timer,
		})
		// The app subscribes at startup. Until it connects, the pull this queues
		// is a no-op, so the first real pull runs inside connect.
		client.subscribe({ collection: "todos" })
		return client
	}

	let builder = new Gatekeeper().add("server", () => server)
	// Register dependencies before any client, preserving stable construction order.
	for (const name of clientNames) {
		builder = builder.add(`${name}Timer`, () => new DstTimer(), timerGates)
	}
	for (const name of clientNames) {
		builder = builder.add(`${name}Storage`, () => new DstClientStorage())
	}
	for (const name of clientNames) {
		builder = builder.add(name, (services, { events }) => {
			// Gatekeeper's fluent type cannot accumulate runtime-generated keys.
			const dependencies = services as typeof services &
				Record<`${DstClientName}Timer`, TimerApi> &
				Record<`${DstClientName}Storage`, TandemClientStorageApi<DstSchema>>
			return createClient(
				name,
				remoteWithPokeEvents(services.server, events),
				dependencies[`${name}Timer`],
				dependencies[`${name}Storage`],
			)
		})
	}
	return builder.build() as DstHarness
}

type DstHarness = Harness<
	{ server: TandemServer<DstSchema, {}> } & Record<
		DstClientName,
		TandemClient<DstSchema>
	>
>
