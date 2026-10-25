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
	type CollectionId,
	defineRelations,
	defineSchema,
	Logger,
	matchBy,
	type MutationOp,
	type RelationalQuery,
	type RemoteApi,
	type RngApi,
	type RuntimeSchemaDefinition,
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
import { isDeepStrictEqual } from "node:util"
import { SimPrng } from "./SimPrng.js"
import { emptyCoverage, type DstCoverage } from "./DstCoverage.js"
import {
	expectedView,
	matchesTask,
	subscriptionQuery,
	type DstSubscriptionMode,
	type DstSubscriptionSpec,
} from "./DstSubscriptions.js"

export type DstSchema = {
	projects: { id: string; name: string }
	tasks: {
		id: string
		projectId: string
		text: string
		done: boolean
		priority: number
	}
	comments: { id: string; taskId: string; body: string }
	memberships: {
		id: readonly [projectId: string, memberId: string]
		role: string
	}
}

export const dstSchemaDefinition = defineSchema({
	projects: collection<DstSchema["projects"]>({ fields: ["id", "name"] }),
	tasks: collection<DstSchema["tasks"]>({
		fields: ["id", "projectId", "text", "done", "priority"],
	}),
	comments: collection<DstSchema["comments"]>({
		fields: ["id", "taskId", "body"],
	}),
	memberships: collection<DstSchema["memberships"]>({ fields: ["id", "role"] }),
}) satisfies RuntimeSchemaDefinition<DstSchema>

/** Records only the server writes, as an agent's reply would be. */
export const serverOwnedIds = ["reply-1", "reply-2"]

export const dstRelations = defineRelations(
	dstSchemaDefinition,
	({ one, many }) => ({
		projects: { tasks: many("tasks", { from: "id", to: "projectId" }) },
		tasks: {
			project: one("projects", { from: "projectId", to: "id" }),
			comments: many("comments", { from: "id", to: "taskId" }),
		},
		comments: { task: one("tasks", { from: "taskId", to: "id" }) },
	}),
)

export const dstCollections = [
	"projects",
	"tasks",
	"comments",
	"memberships",
] as const

export type DstInventory = { [C in keyof DstSchema]: DstSchema[C][] }

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
			if (key[0] === "record" && key[1] === "tasks")
				this.history.get(key[2])?.push(JSON.stringify(value))
		}
		for (const key of writes.remove ?? []) {
			if (key[0] === "record" && key[1] === "tasks")
				this.history.get(key[2])?.push("null")
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

/** Each participant's collection inventories when the run ended. */
export type DstFinalStates = Record<"server", DstInventory> &
	Record<DstClientName, DstInventory>

export type DstCheckpoint = "quiescence" | "ordinary" | "repaired"

export type DstViolation =
	/** A settled client's subscribed view differs from the authoritative server. */
	| {
			kind: "subscriptionView" | "subscriptionNotification"
			checkpoint: DstCheckpoint
			client: DstClientName
			subscriptionId: string
			spec: DstSubscriptionSpec
			expected: unknown[]
			actual: unknown[]
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
			shown: DstSchema["tasks"] | null
			previous: DstSchema["tasks"] | null
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

type DstSubscriptionIntent =
	| {
			type: "subscribe"
			client: DstClientName
			id: string
			spec: DstSubscriptionSpec
	  }
	| { type: "unsubscribe"; client: DstClientName; id: string }

export type DstPartition = "requests" | "replies" | "both"
type DstConnectivityIntent =
	| { type: "disconnect" | "reconnect" | "heal"; client: DstClientName }
	| { type: "partition"; client: DstClientName; direction: DstPartition }

export type DstObservation = {
	spec: DstSubscriptionSpec
	latest: unknown[]
	snapshots: unknown[][]
	destroy: () => void
}

/** Gatekeeper requires an async root for subscription-triggered remote work. */
class DstClient extends TandemClient<DstSchema, typeof dstRelations> {
	async observe(
		install: (client: TandemClient<DstSchema, typeof dstRelations>) => void,
	): Promise<void> {
		install(this)
		await this.pullFromRemote()
	}
}

function installObservation(
	client: TandemClient<DstSchema, typeof dstRelations>,
	observations: Map<string, DstObservation>,
	id: string,
	spec: DstSubscriptionSpec,
	current: () => boolean,
	coverage: DstCoverage,
): void {
	const observation: DstObservation = {
		spec,
		latest: [],
		snapshots: [],
		destroy: () => {},
	}
	const handle = client.subscribe(subscriptionQuery(spec), (result) => {
		// A dead application cannot observe, but a broken destroy must remain visible.
		if (!current()) return
		coverage.callbacks++
		if (result.length > 0) coverage.nonemptyCallbacks++
		if (spec.kind === "tasks") {
			const identities = (rows: readonly unknown[]) =>
				new Set(
					rows.map((row) => JSON.stringify((row as { id: CollectionId }).id)),
				)
			// Initial acquisition and pure reordering do not establish a page transition.
			if (
				(observation.latest.length > 0 || observation.snapshots.length > 1) &&
				!isDeepStrictEqual(identities(observation.latest), identities(result))
			) {
				coverage.pageMembershipChanges++
			}
		}
		observation.latest = structuredClone(result)
		observation.snapshots.push(observation.latest)
	})
	observation.latest = structuredClone(handle.result)
	observation.snapshots.push(observation.latest)
	observation.destroy = handle.destroy
	observations.set(id, observation)
}

export type DstTraceRecord =
	| {
			type: "mutate"
			ops: MutationOp<DstSchema>[]
			step: number
			client: DstClientName
			mutationId: number
	  }
	| ({ type: "advance"; step: number } & DstBoundary)
	| ({ type: "drop"; step: number; fault: DstFaultKind } & DstBoundary)
	| { type: "serverSet"; step: number; item: DstSchema["tasks"] }
	| { type: "serverRemove"; step: number; id: string }
	| { type: "crash"; step: number; client: DstClientName }
	| { type: "restart"; step: number; client: DstClientName; clientId: string }
	| (DstSubscriptionIntent & { step: number })
	| (DstConnectivityIntent & { step: number })
	| { type: "checkpoint" | "repair"; step: number; outcome: DstOutcome }

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
	/** The server writes on its own, as an agent saving its reply would. */
	| { type: "serverSet"; item: DstSchema["tasks"] }
	| { type: "serverRemove"; id: string }
	| { type: "mutate"; client: DstClientName; ops: MutationOp<DstSchema>[] }
	| DstSubscriptionIntent
	| DstConnectivityIntent
	| { type: "checkpoint" | "repair" }
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
	settled: boolean
	coverage: DstCoverage
}

/**
 * The simulated system: a server, clients with timers and durable storage,
 * and the Gatekeeper harness that orders their handoffs.
 * A random run and a replay drive it through the same events.
 */
export class DstWorld implements AsyncDisposable {
	private readonly crashed = new Set<DstClientName>()
	private readonly partitions = new Map<DstClientName, DstPartition>()
	private readonly disconnected = new Set<DstClientName>()
	private readonly failedConnections = new Set<DstClientName>()
	// App intent survives a crash; handles and observations do not.
	private readonly desired: Map<DstClientName, Map<string, DstSubscriptionSpec>>
	private readonly observations: Map<DstClientName, Map<string, DstObservation>>
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
	// Only outstanding targets, for measuring overlap; never predicts record values.
	private readonly activeTargets = new Map<
		string,
		{ client: DstClientName; keys: Set<string> }
	>()
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
	readonly coverage: DstCoverage
	private readonly server: TandemServer<DstSchema, typeof dstRelations>
	private readonly harness: DstHarness
	private readonly storage: InMemoryServerStorage

	private constructor({
		server,
		harness,
		clientNames,
		storage,
		desired,
		observations,
		coverage,
	}: {
		server: TandemServer<DstSchema, typeof dstRelations>
		harness: DstHarness
		clientNames: readonly DstClientName[]
		storage: InMemoryServerStorage
		desired: DstWorld["desired"]
		observations: DstWorld["observations"]
		coverage: DstCoverage
	}) {
		this.server = server
		this.harness = harness
		this.clientNames = clientNames
		this.storage = storage
		this.desired = desired
		this.observations = observations
		this.coverage = coverage
		this.generations = Object.fromEntries(clientNames.map((name) => [name, 0]))
	}

	static async start({
		seed,
		clientCount = 2,
		initialSubscriptions = "full",
	}: {
		seed: number
		clientCount?: number
		initialSubscriptions?: DstSubscriptionMode
	}): Promise<DstWorld> {
		const clientNames = Array.from(
			{ length: clientCount },
			(_, index): DstClientName => `client${index + 1}`,
		)
		const storage = new InMemoryServerStorage()
		const server = new TandemServer<DstSchema, typeof dstRelations>({
			schema: dstSchemaDefinition,
			relations: dstRelations,
			storage,
			rng: SimPrng.idSource(seed, "server"),
		})
		const desired: DstWorld["desired"] = new Map()
		const observations: DstWorld["observations"] = new Map()
		const coverage = emptyCoverage(clientNames)
		for (const name of clientNames) {
			const specs = new Map<string, DstSubscriptionSpec>()
			if (initialSubscriptions === "full")
				for (const collection of dstCollections)
					specs.set(`inventory-${collection}`, {
						kind: "inventory",
						collection,
					})
			if (initialSubscriptions === "scoped")
				specs.set("view-0", {
					kind: "tasks",
					minPriority: 1,
					limit: 3,
					offset: 0,
					projection: false,
				})
			desired.set(name, specs)
			observations.set(name, new Map())
		}
		let world: DstWorld | undefined
		const harness = buildHarness({
			server,
			clientNames,
			onCreate: (name, client) => {
				const generation = world?.generations[name] ?? 0
				for (const [id, spec] of desired.get(name)!)
					installObservation(
						client,
						observations.get(name)!,
						id,
						spec,
						() =>
							!world?.crashed.has(name) &&
							(world?.generations[name] ?? 0) === generation,
						coverage,
					)
			},
			idSource: (label) =>
				SimPrng.idSource(seed, `${label}.${world?.generations[label] ?? 0}`),
		})
		world = new DstWorld({
			server,
			storage,
			harness,
			clientNames,
			desired,
			observations,
			coverage,
		})
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
			case "checkpoint":
				return {
					type: "checkpoint",
					step,
					outcome: await this.checkpoint("ordinary"),
				}
			case "repair":
				return { type: "repair", step, outcome: await this.finish("repaired") }
			case "partition":
				this.partitions.set(intent.client, intent.direction)
				return { ...intent, step }
			case "heal":
				this.partitions.delete(intent.client)
				return { ...intent, step }
			case "disconnect":
				this.coverage.disconnects++
				this.disconnected.add(intent.client)
				this.trackConnection(intent.client, "disconnect")
				return { ...intent, step }
			case "reconnect":
				this.coverage.reconnects++
				this.disconnected.delete(intent.client)
				this.failedConnections.delete(intent.client)
				this.trackConnection(intent.client, "connect")
				return { ...intent, step }
			case "mutate":
				return this.write(step, intent)
			case "serverSet":
			case "serverRemove":
				return this.writeOnServer(step, intent)
			case "subscribe":
				this.coverage.subscriptionChanges++
				this.unsubscribe(intent.client, intent.id)
				this.desired.get(intent.client)!.set(intent.id, intent.spec)
				this.installSubscription(intent.client, intent.id, intent.spec)
				return { ...intent, step }
			case "unsubscribe":
				this.coverage.subscriptionChanges++
				this.unsubscribe(intent.client, intent.id)
				return { ...intent, step }
			case "advance": {
				const target = this.find(intent.call)
				if (this.partitionBlocks(target))
					return this.apply(step, { type: "drop", call: intent.call })
				this.deliveredEvents.add(target.handle)
				this.inFlight.push(target.handle.continueTo(target.waitingFor))
				return { type: "advance", step, ...boundaryOf(target) }
			}
			case "drop": {
				const target = this.find(intent.call)
				const kind = faultKind(target, this.deliveredEvents.has(target.handle))
				this.coverage.dropsByKind[kind]++
				if (this.partitionBlocks(target)) this.coverage.partitionDrops++
				this.inFlight.push(
					target.handle.fail(new DstFaultError({ call: target.name, kind })),
				)
				return { type: "drop", step, fault: kind, ...boundaryOf(target) }
			}
			case "crash": {
				const calls = this.harness
					.pendingCalls()
					.filter(({ label }) => label === `${intent.client}.commit`)
				if (
					calls.some(
						({ waitingFor }) => waitingFor === `${intent.client}Storage`,
					)
				)
					this.coverage.crashesBeforeDurability++
				if (calls.some(({ sentBy }) => sentBy === `${intent.client}Storage`))
					this.coverage.crashesAfterDurability++
				this.crashed.add(intent.client)
				for (const id of serverOwnedIds)
					this.shown.delete(`${intent.client}:${id}`)
				this.observations.get(intent.client)!.clear()
				this.loaded.delete(intent.client)
				this.disconnected.delete(intent.client)
				this.failedConnections.delete(intent.client)
				this.writeCounts.delete(intent.client)
				await this.harness.crash(intent.client)
				return { type: "crash", step, client: intent.client }
			}
			case "restart": {
				this.coverage.restarts++
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
			// Scoped readers may legitimately evict records when their query changes.
			const fullTasks = [...this.subscriptions(name).values()].some(
				({ spec }) => spec.kind === "inventory" && spec.collection === "tasks",
			)
			if (this.loaded.get(name) !== this.generations[name] || !fullTasks) {
				for (const id of serverOwnedIds) this.shown.delete(`${name}:${id}`)
				continue
			}
			const tasks = this.inventoryOf(name).tasks
			for (const id of serverOwnedIds) {
				const history = this.storage.history.get(id)!
				const previous = this.shown.get(`${name}:${id}`) ?? 0
				const task = tasks.find((candidate) => candidate.id === id)
				const index = history.indexOf(JSON.stringify(task ?? null), previous)
				if (index !== -1) {
					this.shown.set(`${name}:${id}`, index)
					continue
				}
				this.orderViolation ??= {
					kind: "movedBackwards",
					step: this.lastStep,
					client: name,
					id,
					shown: task ?? null,
					previous: JSON.parse(history[previous]!) as DstSchema["tasks"] | null,
				}
			}
		}
	}

	/**
	 * Stop injecting faults, finish retained writes over healthy connections,
	 * then pull every client and compare its subscribed view with the server.
	 */
	async finish(checkpoint: DstCheckpoint = "quiescence"): Promise<DstOutcome> {
		await this.drain()

		for (const name of this.down) {
			this.crashed.delete(name)
			this.generations[name] += 1
			await this.harness.restart(name)
			await this.boot(name)
		}
		for (const name of this.clientNames) {
			this.disconnected.delete(name)
			this.failedConnections.delete(name)
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

		const outcome = await this.checkpoint(checkpoint)
		for (const name of this.running) {
			await (
				await this.harness[name].disconnect()
			).result
		}
		return outcome
	}

	async checkpoint(checkpoint: DstCheckpoint): Promise<DstOutcome> {
		this.observeOrder()
		const states: DstFinalStates = {
			server: await this.serverInventory(),
			...Object.fromEntries(
				this.clientNames.map((name) => [name, this.inventoryOf(name)]),
			),
		}
		const violations: DstViolation[] = []
		for (const client of this.running) {
			for (const [subscriptionId, observation] of this.subscriptions(client)) {
				const { spec, latest } = observation
				const expected = expectedView(states.server, spec)
				const local = this.harness[client].query(subscriptionQuery(spec))
				this.coverage.viewChecks++
				if (expected.length > 0) {
					this.coverage.nonemptyViewChecks++
					if (spec.kind === "tasks" && spec.offset > 0)
						this.coverage.offsetViewChecks++
					if (spec.kind === "inventory" && spec.collection === "memberships")
						this.coverage.compoundViewChecks++
					if (
						spec.kind === "projectTasks" &&
						(expected as { tasks: { comments: unknown[] }[] }[]).some(
							({ tasks }) => tasks.some(({ comments }) => comments.length > 0),
						)
					)
						this.coverage.nestedRelationChecks++
					if (
						spec.kind === "taskComments" &&
						(expected as { comments: unknown[] }[]).some(
							({ comments }) => comments.length > 0,
						)
					)
						this.coverage.nestedRelationChecks++
				}
				if (!isDeepStrictEqual(local, expected))
					violations.push({
						kind: "subscriptionView",
						checkpoint,
						client,
						subscriptionId,
						spec,
						expected,
						actual: structuredClone(local),
					})
				if (!isDeepStrictEqual(latest, expected))
					violations.push({
						kind: "subscriptionNotification",
						checkpoint,
						client,
						subscriptionId,
						spec,
						expected,
						actual: latest,
					})
			}
		}
		const clientIds = this.clientNames.map((name) =>
			this.crashed.has(name) ? null : this.harness[name].clientId,
		)
		return {
			violation: this.orderViolation ?? violations[0],
			states,
			clientIds,
			coverage: structuredClone(this.coverage),
			settled:
				this.mutationsInFlight === 0 &&
				this.writers.length === this.clientNames.length &&
				this.offline.length === 0 &&
				this.harness.pendingCalls().length === 0,
		}
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
		intent: Extract<DstIntent, { type: "mutate" }>,
	): DstTraceRecord {
		const client = this.harness[intent.client]
		const tx = client.transact()
		const effectiveOps: MutationOp<DstSchema>[] = []
		for (const op of intent.ops) {
			switch (op.type) {
				case "set":
					tx.set(op.collection, op.value)
					effectiveOps.push(op)
					break
				case "update":
					// Read the public transaction, including earlier operations in this batch.
					if (
						Object.keys(op.payload).length > 0 &&
						tx.get(op.collection, op.id) !== undefined
					)
						effectiveOps.push(op)
					tx.update(op.collection, op.id, op.payload)
					break
				case "remove":
					tx.remove(op.collection, op.id)
					effectiveOps.push(op)
					break
				default:
					return unreachable(op)
			}
		}
		let filterMembershipChanges = 0
		const taskIds = new Set(
			effectiveOps
				.filter((op) => op.collection === "tasks")
				.map((op) =>
					matchBy(op, "type", {
						set: ({ value }) => value.id,
						update: ({ id }) => id,
						remove: ({ id }) => id,
					}),
				),
		)
		for (const id of taskIds) {
			const before = client.query({ collection: "tasks", where: { id } })[0]
			const after = tx.get("tasks", id)
			if (!before || !after) continue
			for (const observer of this.running) {
				for (const { spec } of this.subscriptions(observer).values()) {
					if (
						spec.kind === "tasks" &&
						matchesTask(before, spec) !== matchesTask(after, spec)
					)
						filterMembershipChanges++
				}
			}
		}
		const mutationId = (this.writeCounts.get(intent.client) ?? 0) + 1
		this.writeCounts.set(intent.client, mutationId)
		const generation = this.generations[intent.client]
		const token = `${intent.client}.${generation}.${mutationId}`
		const keys = new Set(
			effectiveOps.map((op) =>
				JSON.stringify([
					op.collection,
					matchBy(op, "type", {
						set: ({ value }) => value.id,
						update: ({ id }) => id,
						remove: ({ id }) => id,
					}),
				]),
			),
		)
		if (
			[...this.activeTargets.values()].some(
				(active) =>
					active.client !== intent.client &&
					[...keys].some((key) => active.keys.has(key)),
			)
		)
			this.coverage.conflictingMutations++
		this.activeTargets.set(token, { client: intent.client, keys })
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
				this.activeTargets.delete(token)
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
				if (effectiveOps.length === 0) return
				this.coverage.filterMembershipChanges += filterMembershipChanges
				this.coverage.mutationsByClient[intent.client]!++
				const size = String(effectiveOps.length)
				this.coverage.batchSizes[size] =
					(this.coverage.batchSizes[size] ?? 0) + 1
				if (effectiveOps.length > 1) this.coverage.multiOperationCommits++
				if (effectiveOps.some((op) => op.collection === "memberships"))
					this.coverage.compoundIdentityCommits++
				for (const op of effectiveOps) {
					const key = `${op.collection}.${op.type}`
					this.coverage.operations[key] =
						(this.coverage.operations[key] ?? 0) + 1
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
		if (intent.type === "serverSet") tx.set("tasks", intent.item)
		else tx.remove("tasks", intent.id)
		// Its pokes, with the records each client views, are events the run can lose.
		this.activeMutations += 1
		this.maxMutationsInFlight = Math.max(
			this.maxMutationsInFlight,
			this.mutationsInFlight,
		)
		this.inFlight.push(
			this.harness.server.commit(tx).then(async (handle) => {
				await handle.result
				this.activeMutations -= 1
			}),
		)
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
			this.failedConnections.add(name)
			// All clients reconnect over a healthy transport during finish().
		})
	}

	get partitioned(): readonly DstClientName[] {
		return [...this.partitions.keys()]
	}

	get offline(): readonly DstClientName[] {
		return [
			...new Set([...this.disconnected, ...this.failedConnections]),
		].filter((name) => !this.crashed.has(name))
	}

	private partitionBlocks(call: DstPendingCall): boolean {
		if (!isNetworkHandoff(call)) return false
		const client = call.sentBy === "server" ? call.waitingFor : call.sentBy
		const direction = this.partitions.get(client as DstClientName)
		return (
			direction === "both" ||
			(direction === "requests" && call.waitingFor === "server") ||
			(direction === "replies" && call.sentBy === "server")
		)
	}

	private trackConnection(
		name: DstClientName,
		method: "connect" | "disconnect",
	): void {
		const generation = this.generations[name]
		this.inFlight.push(
			this.harness[name][method]().then(async (handle) => {
				await handle.result.catch((error: unknown) => {
					if (this.crashed.has(name) || this.generations[name] !== generation)
						return
					if (error instanceof DstFaultError) {
						this.failedConnections.add(name)
						return
					}
					throw error
				})
			}),
		)
	}

	subscriptions(name: DstClientName): ReadonlyMap<string, DstObservation> {
		return this.observations.get(name)!
	}

	private unsubscribe(name: DstClientName, id: string): void {
		this.observations.get(name)!.get(id)?.destroy()
		this.observations.get(name)!.delete(id)
		this.desired.get(name)!.delete(id)
	}

	private installSubscription(
		name: DstClientName,
		id: string,
		spec: DstSubscriptionSpec,
	): void {
		const generation = this.generations[name]
		this.inFlight.push(
			this.harness[name]
				.observe((client) =>
					installObservation(
						client,
						this.observations.get(name)!,
						id,
						spec,
						() =>
							!this.crashed.has(name) && this.generations[name] === generation,
						this.coverage,
					),
				)
				.then(async (handle) => {
					await handle.result.catch((error: unknown) => {
						if (
							error instanceof DstFaultError ||
							this.crashed.has(name) ||
							this.generations[name] !== generation
						)
							return
						throw error
					})
				}),
		)
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

	query<Query extends RelationalQuery<DstSchema, typeof dstRelations>>({
		client,
		query,
	}: {
		client: DstClientName
		query: Query
	}) {
		return this.harness[client].query(query)
	}

	inventoryOf(name: DstClientName): DstInventory {
		const client = this.harness[name]
		return {
			projects: [...client.query({ collection: "projects" })].sort(byId),
			tasks: [...client.query({ collection: "tasks" })].sort(byId),
			comments: [...client.query({ collection: "comments" })].sort(byId),
			memberships: [...client.query({ collection: "memberships" })].sort(byId),
		}
	}

	private async serverInventory(): Promise<DstInventory> {
		const tx = this.server.transact()
		await using cleanup = new errore.AsyncDisposableStack()
		cleanup.defer(() => tx.cancel())
		const [projects, tasks, comments, memberships] = await Promise.all([
			tx.list("projects"),
			tx.list("tasks"),
			tx.list("comments"),
			tx.list("memberships"),
		])
		return {
			projects: [...projects].sort(byId),
			tasks: [...tasks].sort(byId),
			comments: [...comments].sort(byId),
			memberships: [...memberships].sort(byId),
		}
	}
}

function byId(a: { id: CollectionId }, b: { id: CollectionId }): number {
	return JSON.stringify(a.id).localeCompare(JSON.stringify(b.id))
}

function boundaryOf(call: DstPendingCall): DstBoundary {
	return { call: call.name, sentBy: call.sentBy, waitingFor: call.waitingFor }
}

function buildHarness({
	server,
	clientNames,
	idSource,
	onCreate,
}: {
	server: TandemServer<DstSchema, typeof dstRelations>
	clientNames: readonly DstClientName[]
	idSource: (label: DstClientName) => RngApi
	onCreate: (name: DstClientName, client: DstClient) => void
}) {
	const logger = new Logger({ sinks: [] })
	const createClient = (
		label: DstClientName,
		remote: RemoteApi<DstSchema>,
		timer: TimerApi,
		storage: TandemClientStorageApi<DstSchema>,
	) => {
		const client = new DstClient({
			remote,
			clientStorage: storage,
			schema: dstSchemaDefinition,
			relations: dstRelations,
			logger,
			rng: idSource(label),
			autoConnect: false,
			syncInterval: timer,
			clientStorageWriteInterval: timer,
		})
		onCreate(label, client)
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
	{ server: TandemServer<DstSchema, typeof dstRelations> } & Record<
		DstClientName,
		DstClient
	>
>
