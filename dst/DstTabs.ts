import {
	Logger,
	type LoggerEntry,
	type MutationOp,
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
import { InMemoryTupleStorage, type WriteOps } from "tuple-database"
import {
	roundTrip,
	type DstSchema,
	type DstTabName,
	type DstTodo,
} from "./DstWorld.js"
import { SimPrng } from "./SimPrng.js"

/**
 * Work inside a tab group that waits until the run chooses it. Server calls
 * are Gatekeeper calls instead; these cover what Gatekeeper cannot follow
 * across tabs: channel messages, the leader's storage and timers, and pokes.
 */
export type DstTabStepKind = "message" | "save" | "tick" | "poke"

type Step = {
	name: string
	kind: DstTabStepKind
	/** The tab whose work this is; its crash discards the step. */
	owner: DstTabName
	/** A message's sender; its crash loses messages not yet delivered. */
	from?: DstTabName
	/** Pokes can be lost and saves of forwarded writes can fail. */
	droppable: boolean
	run(): void
	drop(): void
}

export type DstTabStep = {
	name: string
	kind: DstTabStepKind
	droppable: boolean
}

/** A broken tab guarantee, named after the check that caught it. */
export type DstTabViolation = {
	kind:
		| "tabCompletedBeforeServer"
		| "tabWriteAppliedTwice"
		| "tabLostAcknowledgedWrite"
		| "tabLostRetainedWrite"
	detail: string
}

/** How often a run reached the situations tab coordination must survive. */
export type DstTabCoverage = {
	/** The leader crashed while another live tab had an unfinished commit. */
	takeoversWithPendingCommits: number
	/** The server accepted a leader push whose reply was lost. */
	acceptedPushRepliesLost: number
	/** A leader save of a forwarded write failed. */
	failedSaves: number
	/** Tab commits that completed after the server accepted them. */
	serverCompletions: number
}

/** A tab's server calls, which the world makes as Gatekeeper calls. */
export type DstTabsRemote = (tab: DstTabName) => RemoteApi<DstSchema>

type Tab = {
	name: DstTabName
	env: InMemoryTab
	client: TandemClient<DstSchema>
	alive: boolean
	ready: boolean
	/** Whether the tab wants the leader connected to the server. */
	wantsServer: boolean
}

type TabWrite = {
	tab: DstTabName
	/** The unique text the write carries, so the server's copy can be found. */
	text: string
	commit: "pending" | "completed" | "rejected"
	/** Whether the tab wanted the server when it wrote. */
	needsServer: boolean
	/** The offline period count when the write was issued. */
	offlineSince: number
}

const storageName = "dst-tabs"
const leaderLock = `tandem:${storageName}`

class DstChannel implements TabChannelApi {
	readonly listeners = new Set<TabMessageListener>()
	closed = false
	discarded = false

	constructor(
		private readonly group: DstTabGroup,
		readonly name: string,
		readonly tab: DstTabName,
		readonly id: number,
	) {}

	postMessage(message: unknown) {
		// Like InMemoryTabs: an ended tab sends nothing, a closed channel throws.
		if (this.discarded) return
		if (this.closed)
			throw new Error("Failed to post message on a closed tab channel")
		this.group.broadcast(this, message)
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

/** The text a set writes; the world tracks tab writes by it. */
function textOf(op: MutationOp<DstSchema>): string | undefined {
	return op.type === "set" ? op.value.text : undefined
}

/**
 * Browser tabs that share one client storage through an elected leader. The
 * world drives them like its other clients; the group holds their tab-only
 * steps and checks what tab coordination promises.
 */
export class DstTabGroup {
	readonly coverage: DstTabCoverage = {
		takeoversWithPendingCommits: 0,
		acceptedPushRepliesLost: 0,
		failedSaves: 0,
		serverCompletions: 0,
	}
	violation: DstTabViolation | undefined
	private readonly tabs = new Map<DstTabName, Tab>()
	private readonly steps: Step[] = []
	private readonly labelCounts = new Map<string, number>()
	private readonly channels: DstChannel[] = []
	// Per sender and receiver, like BroadcastChannel ordering.
	private readonly queues = new Map<string, unknown[]>()
	private readonly storage = new InMemoryTupleStorage()
	private readonly browser = new InMemoryTabs()
	private readonly writes: TabWrite[] = []
	// Leader mutations that delivered each tab write's text to the server.
	private readonly carriers = new Map<string, Set<string>>()
	private readonly logger = new Logger({
		sinks: { log: (entry) => this.observeLog(entry) },
	})
	// A failed save before connecting fails the leader's connection, so its
	// commits can complete offline until it connects again.
	private connectionFailed = false
	private offlinePeriods = 0
	private opened = 0

	constructor(
		private readonly seed: number,
		private readonly remote: DstTabsRemote,
	) {}

	/** Tabs that have not crashed. */
	get alive(): DstTabName[] {
		return [...this.tabs.values()]
			.filter(({ alive }) => alive)
			.map(({ name }) => name)
	}

	/** Live tabs restored from the leader, so they can transact. */
	get writers(): DstTabName[] {
		return [...this.tabs.values()]
			.filter(({ alive, ready }) => alive && ready)
			.map(({ name }) => name)
	}

	get leader(): DstTabName | undefined {
		const holder = this.browser.locks.get(leaderLock)?.holder
		return [...this.tabs.values()].find(
			({ alive, env }) => alive && env === holder,
		)?.name
	}

	pending(): DstTabStep[] {
		return this.steps.map(({ name, kind, droppable }) => ({
			name,
			kind,
			droppable,
		}))
	}

	hasPending(name: string): boolean {
		return this.steps.some((step) => step.name === name)
	}

	advance(name: string) {
		this.take(name).run()
	}

	/** Loses a poke or fails a save, and returns which. */
	drop(name: string): DstTabStepKind {
		const step = this.take(name)
		step.drop()
		return step.kind
	}

	open(): DstTabName {
		const name: DstTabName = `tab${++this.opened}`
		const env = this.browser.openTab()
		const client = new TandemClient<DstSchema>({
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
						const channel = new DstChannel(
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
		const tab: Tab = {
			name,
			env,
			client,
			alive: true,
			ready: false,
			wantsServer: true,
		}
		this.tabs.set(name, tab)
		client.subscribe({ collection: "todos" })
		void client.ready.then(
			() => {
				tab.ready = true
			},
			// A failed save while joining rejects ready, and the app reloads the tab.
			() => this.crash(name),
		)
		return name
	}

	/** Ends a tab as a browser would: its locks, work, and undelivered messages go. */
	crash(name: DstTabName) {
		const tab = this.tabs.get(name)!
		if (!tab.alive) return
		if (
			this.leader === name &&
			this.writes.some(
				(write) =>
					write.tab !== name &&
					write.commit === "pending" &&
					this.tabs.get(write.tab)?.alive,
			)
		)
			this.coverage.takeoversWithPendingCommits += 1
		tab.alive = false
		tab.ready = false
		tab.env.close()
		for (const channel of this.channels)
			if (channel.tab === name) {
				channel.discarded = true
				channel.closed = true
			}
		for (let index = this.steps.length - 1; index >= 0; index--) {
			const step = this.steps[index]!
			if (step.owner === name || step.from === name) this.steps.splice(index, 1)
		}
		for (const channel of this.channels) {
			if (channel.tab !== name) continue
			for (const [key, queue] of this.queues)
				if (key.startsWith(`${channel.id}>`)) queue.length = 0
		}
		this.noteOffline()
	}

	/** Disconnects a tab that wants the server, or connects one that does not. */
	toggle(name: DstTabName): boolean {
		const tab = this.tabs.get(name)!
		tab.wantsServer = !tab.wantsServer
		// A wish can fail to reach a leader that is changing; healing reconnects.
		void (
			tab.wantsServer ? tab.client.connect() : tab.client.disconnect()
		).catch(() => {})
		this.noteOffline()
		return tab.wantsServer
	}

	/** Starts an offline period when no live tab wants the server. */
	private noteOffline() {
		if (!this.alive.some((name) => this.tabs.get(name)!.wantsServer))
			this.offlinePeriods += 1
	}

	/** Commits a change in a tab, and checks its completion against the server. */
	commit(
		name: DstTabName,
		change: (tx: ReturnType<TandemClient<DstSchema>["transact"]>) => void,
		text: string | undefined,
	) {
		const tab = this.tabs.get(name)!
		const tx = tab.client.transact()
		change(tx)
		const write: TabWrite | undefined = text
			? {
					tab: name,
					text,
					commit: "pending",
					needsServer: tab.wantsServer,
					offlineSince: this.offlinePeriods,
				}
			: undefined
		if (write) this.writes.push(write)
		tab.client.commit(tx).then(
			() => {
				if (!write || !tab.alive) return
				write.commit = "completed"
				// Leader connects are never lost, so a commit from a tab that wants the
				// server completes only after the server accepted the write. It may
				// complete offline if this tab or every tab gave up the server, or a
				// failed save failed the leader's connection.
				if (this.carriers.has(write.text)) this.coverage.serverCompletions += 1
				else if (
					write.needsServer &&
					tab.wantsServer &&
					!this.connectionFailed &&
					this.offlinePeriods === write.offlineSince
				)
					this.fail({
						kind: "tabCompletedBeforeServer",
						detail: `${name} completed "${write.text}" before the server accepted it`,
					})
			},
			() => {
				if (write) write.commit = "rejected"
			},
		)
	}

	/** How the public commit of the write carrying `text` has settled so far. */
	commitOf(text: string): TabWrite["commit"] | undefined {
		return this.writes.find((write) => write.text === text)?.commit
	}

	/** Whether shared client storage holds the record `id`. */
	saved(id: string): boolean {
		return this.storage
			.scan()
			.some(({ key }) => key[0] === "record" && key[2] === id)
	}

	todosOf(name: DstTabName): DstTodo[] {
		return [...this.tabs.get(name)!.client.query({ collection: "todos" })]
	}

	/**
	 * Records what the server accepted from a leader push, before its reply
	 * returns. A tab write must reach the server in one leader mutation.
	 */
	accepted(args: Parameters<RemoteApi<DstSchema>["push"]>[0]) {
		for (const mutation of args.mutations)
			for (const op of mutation.ops) {
				const text = textOf(op)
				if (!text || !this.writes.some((write) => write.text === text)) continue
				const carriers = this.carriers.get(text) ?? new Set()
				carriers.add(`${args.clientId}:${mutation.id}`)
				this.carriers.set(text, carriers)
				if (carriers.size > 1)
					this.fail({
						kind: "tabWriteAppliedTwice",
						detail: `"${text}" reached the server in ${[...carriers].join(" and ")}`,
					})
			}
	}

	/** Runs every tab step in order until `work` finishes and nothing is pending. */
	async heal(
		work: (tab: TandemClient<DstSchema>) => Promise<void>,
		settle: () => Promise<void>,
	) {
		if (this.alive.length === 0) this.open()
		// Healing ends with every tab connected.
		for (const tab of this.tabs.values()) tab.wantsServer = true
		let done = false
		let failure: unknown
		void (async () => {
			// A tab whose restore fails is reloaded by its ready handler.
			while (this.alive.some((name) => !this.tabs.get(name)!.ready)) {
				if (this.alive.length === 0) this.open()
				for (const name of this.alive)
					await this.tabs.get(name)!.client.ready.catch(() => {})
			}
			for (const name of this.alive) await work(this.tabs.get(name)!.client)
		})().then(
			() => {
				done = true
			},
			(error: unknown) => {
				done = true
				failure = error
			},
		)
		for (let count = 0, idle = 0; count < 20_000; count++) {
			await settle()
			if (failure) throw new Error(`healing tabs failed: ${String(failure)}`)
			const next = this.steps.shift()
			if (next) {
				idle = 0
				next.run()
				continue
			}
			if (done) return
			if (++idle > 50)
				throw new Error("healing tabs stopped with nothing pending")
		}
		throw new Error("healing tabs did not finish")
	}

	/** After healing: acknowledged writes and writes of live tabs reached the server. */
	checkDelivered() {
		for (const write of this.writes) {
			if (this.carriers.has(write.text)) continue
			if (write.commit === "completed")
				this.fail({
					kind: "tabLostAcknowledgedWrite",
					detail: `${write.tab} completed "${write.text}", but the server never accepted it`,
				})
			if (this.tabs.get(write.tab)?.alive)
				this.fail({
					kind: "tabLostRetainedWrite",
					detail: `${write.tab} is still open, but "${write.text}" never reached the server`,
				})
		}
	}

	close() {
		for (const name of this.alive) this.tabs.get(name)!.env.close()
		this.steps.length = 0
	}

	/** @internal */
	broadcast(sender: DstChannel, message: unknown) {
		for (const receiver of this.channels) {
			if (
				receiver === sender ||
				receiver.name !== sender.name ||
				receiver.closed
			)
				continue
			const key = `${sender.id}>${receiver.id}`
			const queue = this.queues.get(key) ?? []
			this.queues.set(key, queue)
			// Like BroadcastChannel: each receiver gets its own structured clone, later.
			queue.push(structuredClone(message))
			if (queue.length === 1) this.deliverNext(sender, receiver, queue)
		}
	}

	/** Holds a poke the server sent to a leader, so the run can deliver or lose it. */
	poke(tab: DstTabName, poke: () => Promise<void>) {
		this.schedule({
			label: `${tab}.poke`,
			kind: "poke",
			owner: tab,
			droppable: true,
			run: () => void poke(),
		})
	}

	private deliverNext(
		sender: DstChannel,
		receiver: DstChannel,
		queue: unknown[],
	) {
		this.schedule({
			label: `${sender.tab}>${receiver.tab}.message`,
			kind: "message",
			owner: receiver.tab,
			from: sender.tab,
			droppable: false,
			run: () => {
				const data = queue.shift()
				if (!receiver.closed)
					for (const listener of receiver.listeners) listener({ data })
				if (queue.length > 0) this.deliverNext(sender, receiver, queue)
			},
		})
	}

	private take(name: string): Step {
		const index = this.steps.findIndex((step) => step.name === name)
		if (index === -1) throw new Error(`${name} is not pending`)
		return this.steps.splice(index, 1)[0]!
	}

	private schedule({
		label,
		...step
	}: Omit<Step, "name" | "drop"> & { label: string; drop?: () => void }) {
		if (!this.tabs.get(step.owner)?.alive) return
		const count = (this.labelCounts.get(label) ?? 0) + 1
		this.labelCounts.set(label, count)
		this.steps.push({ drop: () => {}, ...step, name: `${label}#${count}` })
	}

	/**
	 * A crashed tab's server calls follow a crashed client's: a request it already
	 * sent still reaches the server, but the reply is lost and anything it calls
	 * afterwards never leaves.
	 */
	private remoteFor(tab: DstTabName): RemoteApi<DstSchema> {
		const remote = this.remote(tab)
		const never = new Promise<never>(() => {})
		const live = <Result>(call: () => Promise<Result>) => {
			if (!this.tabs.get(tab)!.alive) return never
			return call().then((result) =>
				this.tabs.get(tab)!.alive ? result : never,
			)
		}
		return {
			connect: (api) => live(() => remote.connect(api)),
			push: (args) => live(() => remote.push(args)),
			pull: (args) => live(() => remote.pull(args)),
		}
	}

	private storageFor(tab: DstTabName): TandemClientStorageApi<DstSchema> {
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
						kind: "save",
						owner: tab,
						// Fail only saves of forwarded writes; other failures mostly reload tabs.
						droppable:
							writes.set?.some(({ key }) => key[0] === "tab-write") ?? false,
						run: () => {
							this.storage.commit(roundTrip(writes))
							resolve()
						},
						drop: () => {
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

	private timerFor(tab: DstTabName, purpose: "sync" | "save"): TimerApi {
		return {
			waitForNextTick: () =>
				new Promise<void>((resolve) =>
					this.schedule({
						label: `${tab}.${purpose}Tick`,
						kind: "tick",
						owner: tab,
						droppable: false,
						run: resolve,
					}),
				),
		}
	}

	private observeLog(entry: LoggerEntry) {
		const { message, error } = entry.data
		// The leader saves before connecting, so a failed save fails the connect,
		// which the hub logs with its storage cause.
		if (
			entry.level === "error" &&
			message === "error syncing after connect" &&
			error instanceof Error &&
			error.name === "ClientStorageError"
		) {
			this.connectionFailed = true
			this.offlinePeriods += 1
		}
	}

	/** @internal A leader's connect reached the server. */
	connected() {
		this.connectionFailed = false
	}

	private fail(violation: DstTabViolation) {
		this.violation ??= violation
	}
}
