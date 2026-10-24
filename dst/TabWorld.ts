import {
	Logger,
	type LoggerEntry,
	type RemoteApi,
	type TandemClientStorageApi,
	type TandemClientTuple,
	TandemClient,
	type TimerApi,
} from "@tanishqkancharla/tandem-core"
import {
	InMemoryTabs,
	type InMemoryTab,
	type TabChannelApi,
	type TabMessageListener,
} from "@tanishqkancharla/tandem-core/internal"
import { TandemServer } from "@tanishqkancharla/tandem-server"
import { InMemoryTupleStorage, type WriteOps } from "tuple-database"
import {
	type DstSchema,
	type DstTodo,
	dstSchemaDefinition,
	InMemoryServerStorage,
	roundTrip,
} from "./DstWorld.js"
import { SimPrng } from "./SimPrng.js"

/**
 * What a held step models. Requests, replies, and pokes cross the network and
 * can be lost. Storage commits of forwarded writes can fail. Messages and
 * timer ticks only wait.
 */
export type TabStepKind =
	| "message"
	| "request"
	| "reply"
	| "poke"
	| "storage"
	| "tick"

type Step = {
	name: string
	kind: TabStepKind
	/** The tab whose work this is; a crash discards it, except requests already sent. */
	owner: string
	/** A message's sender; its crash loses messages not yet delivered. */
	from?: string
	/** Whether a fault may lose or fail it. */
	faultable: boolean
	run(): void
	fault(): void
}

export type TabPendingStep = {
	name: string
	kind: TabStepKind
	faultable: boolean
}

export type TabTraceRecord =
	| { type: "open"; step: number; tab: string }
	| { type: "close"; step: number; tab: string }
	| { type: "crash"; step: number; tab: string; leader: boolean }
	| { type: "write"; step: number; tab: string; id: string }
	| { type: "flush"; step: number; tab: string }
	| { type: "toggle"; step: number; tab: string; wantsServer: boolean }
	| { type: "advance"; step: number; call: string }
	| { type: "fault"; step: number; call: string; lost: TabStepKind }

export type TabIntent =
	| { type: "open" }
	| { type: "close"; tab: string }
	| { type: "crash"; tab: string }
	| { type: "write"; tab: string }
	| { type: "flush"; tab: string }
	| { type: "toggle"; tab: string }
	| { type: "advance"; call: string }
	| { type: "fault"; call: string }

/** A broken guarantee, named after the oracle that caught it. */
export type TabViolation = {
	kind:
		| "completedBeforeServer"
		| "completedBeforeSave"
		| "flushedBeforeSave"
		| "lostAcknowledgedWrite"
		| "lostRetainedWrite"
		| "writeAppliedTwice"
		| "tabDiverged"
		| "unsettled"
	detail: string
}

/** How often a run reached the situations shared tabs exist to survive. */
export type TabCoverage = {
	/** The leader crashed or closed while another live tab had an unfinished commit. */
	takeoversWithPendingCommits: number
	/** The server accepted a push whose reply was lost. */
	acceptedPushRepliesLost: number
	/** A leader storage commit failed. */
	failedSaves: number
	/** Commits that completed after the server received them. */
	serverCompletions: number
	/** Tabs whose restore failed on a failed leader save, so the app reloaded them. */
	failedRestores: number
}

export type TabOutcome = {
	violation: TabViolation | undefined
	coverage: TabCoverage
	server: DstTodo[]
}

type SimTab = {
	name: string
	env: InMemoryTab
	client: TandemClient<DstSchema>
	/** False once crashed or closed. */
	alive: boolean
	/** Closing tabs still run, but take no new work. */
	closing: boolean
	ready: boolean
	/** Whether the tab wants the leader connected to the server. */
	wantsServer: boolean
}

type WriteRecord = {
	id: string
	tab: string
	item: DstTodo
	/** Whether the server must have the write when its commit completes. */
	needsServer: boolean
	/** The offline period count when the write was issued. */
	offlineSince: number
	acknowledged: boolean
	commit: "pending" | "completed" | "rejected"
}

const storageName = "dst"
const leaderLock = `tandem:${storageName}`
const unavailable = {
	error: "unavailable",
	message: "Lost in transit",
} as const

/** Lets promise continuations settle so the next step sees stable state. */
function settle(): Promise<void> {
	return new Promise((resolve) => setImmediate(resolve))
}

class SimChannel implements TabChannelApi {
	readonly listeners = new Set<TabMessageListener>()
	closed = false
	discarded = false

	constructor(
		private readonly world: TabWorld,
		readonly name: string,
		readonly tab: string,
		readonly id: number,
	) {}

	postMessage(message: unknown) {
		// Matches InMemoryTabs: an ended tab sends nothing, a closed channel throws.
		if (this.discarded) return
		if (this.closed)
			throw new Error("Failed to post message on a closed tab channel")
		this.world.broadcast(this, message)
	}

	addEventListener(_type: "message", listener: TabMessageListener) {
		this.listeners.add(listener)
	}

	removeEventListener(_type: "message", listener: TabMessageListener) {
		this.listeners.delete(listener)
	}

	close() {
		this.closed = true
	}
}

/**
 * Browser tabs sharing one client storage and one server. Every channel
 * delivery, network request and reply, storage commit, and timer tick waits as
 * a named step until the run chooses it, so a seed fixes the interleaving.
 */
export class TabWorld implements AsyncDisposable {
	readonly tabs = new Map<string, SimTab>()
	readonly coverage: TabCoverage = {
		takeoversWithPendingCommits: 0,
		acceptedPushRepliesLost: 0,
		failedSaves: 0,
		serverCompletions: 0,
		failedRestores: 0,
	}
	violation: TabViolation | undefined
	private readonly server: TandemServer<DstSchema, {}>
	private readonly serverStorage = new InMemoryServerStorage()
	private readonly storage = new InMemoryTupleStorage()
	private readonly browser = new InMemoryTabs()
	private readonly logger = new Logger({
		sinks: { log: (entry) => this.observeLog(entry) },
	})
	// Counts periods in which the leader may be offline: no open tab wanted the
	// server, or the leader's connection failed on a failed save.
	private offlinePeriods = 0
	private connectionFailed = false
	private readonly steps: Step[] = []
	private readonly labelCounts = new Map<string, number>()
	private readonly channels: SimChannel[] = []
	// Per sender and receiver, like BroadcastChannel ordering.
	private readonly queues = new Map<string, unknown[]>()
	private readonly writes: WriteRecord[] = []
	private readonly pendingCommits = new Set<WriteRecord>()
	private readonly carriers = new Map<string, Set<string>>()
	private opened = 0

	private constructor(private readonly seed: number) {
		this.server = new TandemServer<DstSchema, {}>({
			schema: dstSchemaDefinition,
			relations: {},
			storage: this.serverStorage,
			rng: SimPrng.idSource(seed, "server"),
		})
	}

	static start(seed: number, tabs = 2): TabWorld {
		const world = new TabWorld(seed)
		for (let index = 0; index < tabs; index++) world.open()
		return world
	}

	/** Tabs that are running and not closing. */
	get alive(): SimTab[] {
		return [...this.tabs.values()].filter(
			({ alive, closing }) => alive && !closing,
		)
	}

	/** Live tabs restored from the leader, so they can transact. */
	get writers(): SimTab[] {
		return this.alive.filter(({ ready }) => ready)
	}

	/** Tabs that have not crashed or finished closing. */
	get running(): SimTab[] {
		return [...this.tabs.values()].filter(({ alive }) => alive)
	}

	get leader(): string | undefined {
		const holder = this.browser.locks.get(leaderLock)?.holder
		return this.running.find(({ env }) => env === holder)?.name
	}

	pending(): TabPendingStep[] {
		return this.steps.map(({ name, kind, faultable }) => ({
			name,
			kind,
			faultable,
		}))
	}

	apply(step: number, intent: TabIntent): TabTraceRecord {
		switch (intent.type) {
			case "open":
				return { type: "open", step, tab: this.open() }
			case "close":
				this.close(intent.tab)
				return { type: "close", step, tab: intent.tab }
			case "crash":
				return { type: "crash", step, ...this.crash(intent.tab) }
			case "write":
				return {
					type: "write",
					step,
					tab: intent.tab,
					id: this.write(intent.tab),
				}
			case "toggle":
				return {
					type: "toggle",
					step,
					tab: intent.tab,
					wantsServer: this.toggle(intent.tab),
				}
			case "flush":
				this.flush(intent.tab)
				return { type: "flush", step, tab: intent.tab }
			case "advance":
				this.take(intent.call).run()
				return { type: "advance", step, call: intent.call }
			case "fault": {
				const target = this.take(intent.call)
				target.fault()
				return { type: "fault", step, call: intent.call, lost: target.kind }
			}
		}
	}

	/** Whether the run has seen `id`'s commit or a later flush complete. */
	acknowledged(id: string): boolean {
		return this.writes.some((write) => write.id === id && write.acknowledged)
	}

	/** How the public commit of write `id` has settled so far. */
	commitOf(id: string): WriteRecord["commit"] | undefined {
		return this.writes.find((write) => write.id === id)?.commit
	}

	/** Whether shared client storage holds the record `id`. */
	saved(id: string): boolean {
		return this.storage
			.scan()
			.some(({ key }) => key[0] === "record" && key[2] === id)
	}

	hasPending(call: string): boolean {
		return this.steps.some(({ name }) => name === call)
	}

	async settle(): Promise<void> {
		await settle()
	}

	/**
	 * Heal the system: run every step in order, keep a tab open, and have each
	 * live tab flush, connect, and pull. Then check what must have survived.
	 */
	async finish(): Promise<TabOutcome> {
		const healed = await this.drive(async (stage) => {
			// A tab whose restore failed before healing is reloaded by its ready handler.
			while (!this.alive.every(({ ready }) => ready)) {
				if (this.alive.length === 0) this.open()
				for (const { name, client } of this.alive) {
					stage(`${name} ready`)
					await client.ready.catch(() => {})
				}
			}
			for (const { name, client } of this.alive) {
				stage(`${name} flush`)
				// A save that failed before healing can still reject one flush; the next
				// flush resends the write.
				for (let attempt = 0; attempt < 3; attempt++) {
					const flushed = await client.flushClientStorage().then(
						() => true,
						() => false,
					)
					if (flushed) break
				}
			}
			for (const tab of this.alive) tab.wantsServer = true
			for (const { name, client } of this.alive) {
				stage(`${name} connect`)
				await client.connect()
			}
			for (const { name, client } of this.alive) {
				stage(`${name} pull`)
				await client.pullFromRemote()
			}
		})
		if (healed instanceof Error)
			this.fail({ kind: "unsettled", detail: healed.message })
		const server = this.serverTodos()
		for (const write of this.writes) {
			if (server.some(({ id }) => id === write.id)) continue
			if (write.acknowledged)
				this.fail({
					kind: "lostAcknowledgedWrite",
					detail: `${write.tab} acknowledged ${write.id}, but the server never received it`,
				})
			if (this.alive.some(({ name }) => name === write.tab))
				this.fail({
					kind: "lostRetainedWrite",
					detail: `${write.tab} is still open, but its ${write.id} never reached the server`,
				})
		}
		for (const tab of this.alive) {
			const actual = sorted([...tab.client.query({ collection: "todos" })])
			if (JSON.stringify(actual) !== JSON.stringify(server))
				this.fail({
					kind: "tabDiverged",
					detail: `${tab.name} shows ${actual.map(({ id }) => id).join(",")}; server has ${server.map(({ id }) => id).join(",")}`,
				})
		}
		return { violation: this.violation, coverage: this.coverage, server }
	}

	async [Symbol.asyncDispose](): Promise<void> {
		for (const tab of this.running) {
			tab.alive = false
			tab.env.close()
		}
		this.steps.length = 0
		await this.server.close()
	}

	/** @internal */
	broadcast(sender: SimChannel, message: unknown) {
		for (const receiver of this.channels) {
			if (receiver === sender || receiver.name !== sender.name) continue
			if (receiver.closed) continue
			const key = `${sender.id}>${receiver.id}`
			const queue = this.queues.get(key) ?? []
			this.queues.set(key, queue)
			// Like BroadcastChannel: each receiver gets its own structured clone, later.
			queue.push(structuredClone(message))
			if (queue.length === 1) this.scheduleDelivery(sender, receiver, queue)
		}
	}

	private scheduleDelivery(
		sender: SimChannel,
		receiver: SimChannel,
		queue: unknown[],
	) {
		this.schedule({
			label: `${sender.tab}>${receiver.tab}.message`,
			kind: "message",
			owner: receiver.tab,
			from: sender.tab,
			faultable: false,
			run: () => {
				const data = queue.shift()
				if (!receiver.closed)
					for (const listener of receiver.listeners) listener({ data })
				if (queue.length > 0) this.scheduleDelivery(sender, receiver, queue)
			},
		})
	}

	private open(): string {
		const name = `tab${++this.opened}`
		const env = this.browser.openTab()
		const client = new TandemClient<DstSchema>({
			schema: dstSchemaDefinition,
			remote: this.remoteFor(name),
			clientStorage: this.storageFor(name),
			logger: this.logger,
			rng: SimPrng.idSource(this.seed, name),
			autoConnect: true,
			syncInterval: this.timerFor(name, "sync"),
			clientStorageWriteInterval: this.timerFor(name, "save"),
			tabs: {
				name: storageName,
				environment: {
					locks: env.locks,
					openChannel: (channelName) => {
						const channel = new SimChannel(
							this,
							channelName,
							name,
							this.channels.length,
						)
						this.channels.push(channel)
						return channel
					},
				},
			},
		})
		const tab: SimTab = {
			name,
			env,
			client,
			alive: true,
			closing: false,
			ready: false,
			wantsServer: true,
		}
		this.tabs.set(name, tab)
		client.subscribe({ collection: "todos" })
		void client.ready.then(
			() => {
				tab.ready = true
			},
			// A failed save while joining rejects ready, as a failed first pull did. The
			// app reloads such a tab.
			() => {
				if (!tab.alive) return
				this.coverage.failedRestores += 1
				this.end(tab)
			},
		)
		return name
	}

	private close(name: string) {
		const tab = this.tabs.get(name)!
		this.countTakeover(name)
		// A closing tab saves first, so its writes stay acknowledged by later leaders.
		tab.closing = true
		this.noteOffline()
		void tab.client.close().then(() => this.end(tab))
	}

	private crash(name: string) {
		const leader = this.leader === name
		this.countTakeover(name)
		this.end(this.tabs.get(name)!)
		this.noteOffline()
		// A crashed tab's messages that the browser has not delivered are lost too.
		for (let index = this.steps.length - 1; index >= 0; index--)
			if (this.steps[index]!.from === name) this.steps.splice(index, 1)
		for (const channel of this.channels) {
			if (channel.tab !== name) continue
			for (const [key, queue] of this.queues)
				if (key.startsWith(`${channel.id}>`)) queue.length = 0
		}
		return { tab: name, leader }
	}

	private end(tab: SimTab) {
		if (!tab.alive) return
		tab.alive = false
		tab.ready = false
		tab.env.close()
		for (const channel of this.channels)
			if (channel.tab === tab.name) {
				channel.discarded = true
				channel.closed = true
			}
		// Requests already sent still reach the server; everything else in the tab stops.
		for (let index = this.steps.length - 1; index >= 0; index--) {
			const step = this.steps[index]!
			if (step.owner === tab.name && step.kind !== "request")
				this.steps.splice(index, 1)
		}
		for (const write of this.pendingCommits)
			if (write.tab === tab.name) this.pendingCommits.delete(write)
	}

	private countTakeover(name: string) {
		if (this.leader !== name) return
		if ([...this.pendingCommits].some(({ tab }) => tab !== name))
			this.coverage.takeoversWithPendingCommits += 1
	}

	private write(name: string): string {
		const tab = this.tabs.get(name)!
		const id = `w${this.writes.length + 1}`
		const item: DstTodo = {
			id,
			text: `Written by ${name}`,
			done: false,
			priority: this.writes.length,
		}
		const tx = tab.client.transact()
		tx.set("todos", item)
		const write: WriteRecord = {
			id,
			tab: name,
			item,
			needsServer: tab.wantsServer,
			offlineSince: this.offlinePeriods,
			acknowledged: false,
			commit: "pending",
		}
		this.writes.push(write)
		this.pendingCommits.add(write)
		tab.client.commit(tx).then(
			() => {
				this.pendingCommits.delete(write)
				if (!tab.alive) return
				write.commit = "completed"
				write.acknowledged = true
				// Connections are never lost, so a commit from a tab that wants the server
				// completes only after the server has it, unless the leader went offline
				// meanwhile: this tab or every tab gave up the server, or its connection
				// failed.
				if (this.serverHas(item)) this.coverage.serverCompletions += 1
				else if (
					write.needsServer &&
					tab.wantsServer &&
					!this.connectionFailed &&
					this.offlinePeriods === write.offlineSince
				)
					this.fail({
						kind: "completedBeforeServer",
						detail: `${name} completed ${id} before the server received it`,
					})
				if (!this.saved(id))
					this.fail({
						kind: "completedBeforeSave",
						detail: `${name} completed ${id} before shared storage held it`,
					})
			},
			() => {
				this.pendingCommits.delete(write)
				write.commit = "rejected"
			},
		)
		return id
	}

	/** Disconnects a tab that wants the server, or connects one that does not. */
	private toggle(name: string) {
		const tab = this.tabs.get(name)!
		tab.wantsServer = !tab.wantsServer
		const request = tab.wantsServer
			? tab.client.connect()
			: tab.client.disconnect()
		// A tab's wish can fail to reach a leader that is changing; healing reconnects.
		void request.catch(() => {})
		this.noteOffline()
		return tab.wantsServer
	}

	/** Starts an offline period when no open tab wants the server. */
	private noteOffline() {
		if (!this.alive.some(({ wantsServer }) => wantsServer))
			this.offlinePeriods += 1
	}

	private observeLog(entry: LoggerEntry) {
		const { message, error } = entry.data
		// A failed save before connecting fails the leader's connection, so commits
		// complete offline until it connects again.
		if (
			entry.level === "error" &&
			error instanceof Error &&
			error.name === "ClientStorageError" &&
			(message === "error connecting tab replica" ||
				message === "error serving tab request" ||
				message === "error watching tab lifetime")
		) {
			this.connectionFailed = true
			this.offlinePeriods += 1
		}
	}

	private flush(name: string) {
		const tab = this.tabs.get(name)!
		const covered = this.writes.filter((write) => write.tab === name)
		tab.client.flushClientStorage().then(
			() => {
				if (!tab.alive) return
				for (const write of covered) {
					write.acknowledged = true
					if (!this.saved(write.id))
						this.fail({
							kind: "flushedBeforeSave",
							detail: `${name} flushed before shared storage held ${write.id}`,
						})
				}
			},
			// A failed save rejects the flush; the tab keeps and resends its writes.
			() => {},
		)
	}

	/** Runs every step in order until `work` finishes and nothing is pending. */
	private async drive(work: (stage: (name: string) => void) => Promise<void>) {
		let done = false
		let failure: unknown
		let current = ""
		let idle = 0
		void work((name) => {
			current = name
		}).then(
			() => {
				done = true
			},
			(error: unknown) => {
				done = true
				failure = error
			},
		)
		for (let count = 0; count < 20_000; count++) {
			await settle()
			if (failure) return new Error(`healing failed at ${current}: ${failure}`)
			const next = this.steps.shift()
			if (!next) {
				if (done) return
				idle += 1
				if (idle > 50)
					return new Error(`healing stopped at ${current} with nothing pending`)
				continue
			}
			idle = 0
			next.run()
		}
		return new Error(
			`still running after 20000 healing steps at ${current}: ${this.steps
				.slice(0, 8)
				.map(({ name }) => name)
				.join(", ")}`,
		)
	}

	private take(call: string): Step {
		const index = this.steps.findIndex(({ name }) => name === call)
		if (index === -1) throw new Error(`${call} is not pending`)
		return this.steps.splice(index, 1)[0]!
	}

	private schedule({
		label,
		...step
	}: Omit<Step, "name" | "fault"> & { label: string; fault?: () => void }) {
		const tab = this.tabs.get(step.owner)
		if (tab && !tab.alive && step.kind !== "request") return
		const count = (this.labelCounts.get(label) ?? 0) + 1
		this.labelCounts.set(label, count)
		this.steps.push({ fault: () => {}, ...step, name: `${label}#${count}` })
	}

	private remoteFor(tab: string): RemoteApi<DstSchema> {
		const isAlive = () => this.tabs.get(tab)?.alive ?? true
		const call = <Result>(
			operation: "connect" | "push" | "pull",
			send: () => Promise<Result>,
			lost: Result,
			faultable: boolean,
			onLostReply = () => {},
		) =>
			new Promise<Result>((resolve) => {
				this.schedule({
					label: `${tab}.${operation}`,
					kind: "request",
					owner: tab,
					faultable,
					run: () =>
						void send().then((result) =>
							this.schedule({
								label: `${tab}.${operation}.reply`,
								kind: "reply",
								owner: tab,
								faultable,
								run: () => {
									if (operation === "connect" && typeof result === "function")
										this.connectionFailed = false
									resolve(result)
								},
								fault: () => {
									onLostReply()
									resolve(lost)
								},
							}),
						),
					fault: () => {
						if (isAlive()) resolve(lost)
					},
				})
			})
		return {
			// Connections are never lost, so an online leader stays online. Delays still apply.
			connect: (api) =>
				call<Awaited<ReturnType<RemoteApi<DstSchema>["connect"]>>>(
					"connect",
					() =>
						this.server.connect({
							...api,
							poke: () => {
								this.schedule({
									label: `${tab}.poke`,
									kind: "poke",
									owner: tab,
									faultable: true,
									run: () => void api.poke(),
								})
								return Promise.resolve()
							},
						}),
					unavailable,
					false,
				),
			push: (args) =>
				call(
					"push",
					() => {
						for (const mutation of args.mutations)
							for (const op of mutation.ops) {
								if (op.type !== "set") continue
								const carriers = this.carriers.get(op.value.id) ?? new Set()
								carriers.add(`${args.clientId}:${mutation.id}`)
								this.carriers.set(op.value.id, carriers)
								if (carriers.size > 1)
									this.fail({
										kind: "writeAppliedTwice",
										detail: `${op.value.id} reached the server in ${[...carriers].join(" and ")}`,
									})
							}
						return this.server.push(args)
					},
					unavailable,
					true,
					() => {
						this.coverage.acceptedPushRepliesLost += 1
					},
				),
			pull: (args) =>
				call("pull", () => this.server.pull(args), unavailable, true),
		}
	}

	private storageFor(tab: string): TandemClientStorageApi<DstSchema> {
		return {
			name: storageName,
			scan: (args) =>
				Promise.resolve(
					roundTrip(this.storage.scan(args)) as TandemClientTuple<DstSchema>[],
				),
			commit: (writes: WriteOps<TandemClientTuple<DstSchema>>) =>
				new Promise<void>((resolve, reject) =>
					this.schedule({
						label: `${tab}.save`,
						kind: "storage",
						owner: tab,
						// Fail only saves of forwarded writes; other failed saves mostly reload tabs.
						faultable:
							writes.set?.some(({ key }) => key[0] === "tab-write") ?? false,
						run: () => {
							this.storage.commit(roundTrip(writes))
							resolve()
						},
						fault: () => {
							this.coverage.failedSaves += 1
							reject(new Error("Storage commit failed"))
						},
					}),
				),
			clear: () => {
				this.storage.commit({
					remove: this.storage.scan().map(({ key }) => key),
				})
				return Promise.resolve()
			},
			close: () => Promise.resolve(),
		}
	}

	private timerFor(tab: string, purpose: "sync" | "save"): TimerApi {
		return {
			waitForNextTick: () =>
				new Promise<void>((resolve) =>
					this.schedule({
						label: `${tab}.${purpose}Tick`,
						kind: "tick",
						owner: tab,
						faultable: false,
						run: resolve,
					}),
				),
		}
	}

	private serverHas(item: DstTodo) {
		return this.serverStorage
			.records()
			.some(
				({ key, value }) =>
					key[2] === item.id && JSON.stringify(value) === JSON.stringify(item),
			)
	}

	private serverTodos(): DstTodo[] {
		return sorted(
			this.serverStorage
				.records()
				.filter(({ key }) => key[1] === "todos")
				.map(({ value }) => value as DstTodo),
		)
	}

	private fail(violation: TabViolation) {
		this.violation ??= violation
	}
}

function sorted(todos: DstTodo[]): DstTodo[] {
	return todos.sort((a, b) => a.id.localeCompare(b.id))
}
