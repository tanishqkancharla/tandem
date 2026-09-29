/**
 * A small model of Tandem sync, used to draw the videos. `current` follows the
 * rules on main; `proposed` follows the Replicache-style design from the issues.
 * Pushes and pulls are explicit steps instead of timer ticks and pokes, and a
 * client's window is either every record or none.
 */
export type Model = "current" | "proposed"
export type ClientName = "client1" | "client2"
export const CLIENTS: ClientName[] = ["client1", "client2"]

export type Records = Record<string, string>
export type Op =
	| { type: "set"; key: string; value: string }
	| { type: "remove"; key: string }

export type Action =
	| { a: "subscribe"; c: ClientName }
	| { a: "set"; c: ClientName; key: string; value: string }
	| { a: "remove"; c: ClientName; key: string }
	| { a: "push"; c: ClientName; lost?: boolean }
	| { a: "pull"; c: ClientName }
	| { a: "crash"; c: ClientName }
	| { a: "restart"; c: ClientName }

export type Party = ClientName | "server"
export type Message = { from: Party; to: Party; label: string; lost?: boolean }
export type Note = { kind: "info" | "bad" | "good"; text: string }

export type ClientView = {
	up: boolean
	subscribed: boolean
	records: Records
	pending: { text: string; detail?: string }[]
	pendingLabel: string
	base?: Records
}
export type Snapshot = {
	clients: Record<ClientName, ClientView>
	server: { records: Records; facts: string[] }
	messages: Message[]
	notes: Note[]
}

const fmtOp = (op: Op) =>
	op.type === "set" ? `set ${op.key} = "${op.value}"` : `remove ${op.key}`
const short = (c: ClientName) => (c === "client1" ? "c1" : "c2")
const sorted = (records: Records) =>
	Object.fromEntries(Object.entries(records).sort(([a], [b]) => a.localeCompare(b)))
function applyOp(records: Records, op: Op) {
	if (op.type === "set") records[op.key] = op.value
	else delete records[op.key]
}
const listKeys = (keys: string[]) => (keys.length ? keys.join(", ") : "")
const ids = (list: string[]) => list.join(", ")

type Step = { messages: Message[]; notes: Note[] }

export interface World {
	apply(action: Action): Step
	snapshot(step: Step): Snapshot
	serverRecords(): Records
	clientRecords(c: ClientName): Records
}

// ─── main today ───────────────────────────────────────────────────────────
type CurrentMutation = { id: string; ops: Op[]; undo: Op[] }
type CurrentClient = {
	gen: number
	up: boolean
	subscribed: boolean
	visible: Records
	speculative: CurrentMutation[]
	outbox: CurrentMutation[]
	cookie?: number
	counter: number
	disk: Records
}

class CurrentWorld implements World {
	private server = {
		records: {} as Records,
		revision: 0,
		clients: {} as Record<string, { synced?: string[]; ack?: string }>,
	}
	private clients: Record<ClientName, CurrentClient> = {
		client1: this.newClient(0),
		client2: this.newClient(0),
	}

	private newClient(gen: number): CurrentClient {
		return { gen, up: true, subscribed: false, visible: {}, speculative: [], outbox: [], counter: 0, disk: {} }
	}
	private serverClient(c: ClientName) {
		const id = `${c}#${this.clients[c].gen}`
		return (this.server.clients[id] ??= {})
	}

	apply(action: Action): Step {
		const messages: Message[] = []
		const notes: Note[] = []
		const cl = this.clients[action.c]
		const c = action.c
		switch (action.a) {
			case "subscribe":
				cl.subscribed = true
				break
			case "set": {
				const prev = cl.visible[action.key]
				const op: Op = { type: "set", key: action.key, value: action.value }
				const undo: Op = prev === undefined ? { type: "remove", key: action.key } : { type: "set", key: action.key, value: prev }
				cl.visible[action.key] = action.value
				this.commit(c, [op], [undo])
				break
			}
			case "remove": {
				const prev = cl.visible[action.key]
				if (prev === undefined) {
					notes.push({ kind: "bad", text: `${action.key} isn't local, so the remove records nothing` })
					break
				}
				delete cl.visible[action.key]
				this.commit(c, [{ type: "remove", key: action.key }], [{ type: "set", key: action.key, value: prev }])
				notes.push({ kind: "info", text: `The remove saves "${prev}" as its undo value` })
				break
			}
			case "push": {
				if (cl.outbox.length === 0) {
					notes.push({ kind: "info", text: `${c} has nothing left to push` })
					break
				}
				const ms = cl.outbox
				cl.outbox = []
				const label = `push ${ms.map((m) => m.id).join(", ")}`
				if (action.lost) {
					messages.push({ from: c, to: "server", label, lost: true })
					for (const m of [...ms].reverse()) for (const op of m.undo) applyOp(cl.visible, op)
					cl.speculative = cl.speculative.filter((m) => !ms.includes(m))
					cl.disk = { ...cl.visible }
					notes.push({ kind: "bad", text: `The failed push is treated as a rejection: ${ms.map((m) => m.id).join(", ")} rolled back and never retried` })
					break
				}
				messages.push({ from: c, to: "server", label })
				for (const m of ms) for (const op of m.ops) applyOp(this.server.records, op)
				this.serverClient(c).ack = ms.at(-1)!.id
				this.server.revision++
				break
			}
			case "pull":
				this.pull(c, messages, notes)
				break
			case "crash":
				cl.up = false
				if (cl.speculative.length)
					notes.push({ kind: "bad", text: `Storage keeps only records. ${cl.speculative.map((m) => m.id).join(", ")} and the outbox are lost` })
				break
			case "restart": {
				const disk = cl.disk
				this.clients[c] = { ...this.newClient(cl.gen + 1), subscribed: cl.subscribed, visible: { ...disk }, disk: { ...disk } }
				const keys = Object.keys(disk)
				notes.push({ kind: "bad", text: `Restarts with a new client id. ${listKeys(keys) || "Its records"} ${keys.length === 1 ? "loads" : "load"} as if confirmed, with nothing to push` })
				break
			}
		}
		return { messages, notes }
	}

	private commit(c: ClientName, ops: Op[], undo: Op[]) {
		const cl = this.clients[c]
		const m = { id: `${short(c)}·m${++cl.counter}`, ops, undo }
		cl.speculative.push(m)
		cl.outbox.push(m)
		cl.disk = { ...cl.visible }
	}

	private pull(c: ClientName, messages: Message[], notes: Note[]) {
		const cl = this.clients[c]
		const sc = this.serverClient(c)
		const shouldRead = sc.synced === undefined || cl.cookie !== this.server.revision
		const current = shouldRead && cl.subscribed ? Object.keys(this.server.records).sort() : []
		const remove = shouldRead ? (sc.synced ?? []).filter((k) => !current.includes(k)) : []
		const set = current.map((k) => [k, this.server.records[k]!] as const)
		const ack = sc.ack
		sc.ack = undefined
		if (shouldRead) sc.synced = current
		cl.cookie = this.server.revision
		messages.push({ from: c, to: "server", label: "pull" })
		messages.push({
			from: "server",
			to: c,
			label: `set [${listKeys(set.map(([k]) => k))}] · remove [${listKeys(remove)}] · ack ${ack ?? "none"}`,
		})

		if (set.length === 0 && remove.length === 0) {
			if (ack !== undefined) notes.push({ kind: "bad", text: `Empty patch: applyPatchAt returns early and drops the ack for ${ack}` })
			return
		}
		const idx = cl.speculative.findIndex((m) => m.id === ack)
		for (const m of [...cl.speculative].reverse()) for (const op of m.undo) applyOp(cl.visible, op)
		for (const [k, v] of set) cl.visible[k] = v
		for (const k of remove) delete cl.visible[k]
		const still = cl.speculative.slice(idx + 1)
		for (const m of still) for (const op of m.ops) applyOp(cl.visible, op)
		const covered = new Set([...set.map(([k]) => k), ...remove, ...still.flatMap((m) => m.ops.map((op) => op.key))])
		for (const m of cl.speculative.slice(0, idx + 1))
			for (const op of m.undo)
				if (op.type === "set" && !covered.has(op.key))
					notes.push({ kind: "bad", text: `Undoing acked ${m.id} restores ${op.key} "${op.value}", and the patch has no remove for it` })
		cl.speculative = still
		cl.disk = { ...cl.visible }
		notes.push({ kind: "info", text: "Rebase: undo unconfirmed writes with their saved undo values, apply the patch, redo the rest" })
	}

	snapshot(step: Step): Snapshot {
		const client = (c: ClientName): ClientView => {
			const cl = this.clients[c]
			return {
				up: cl.up,
				subscribed: cl.subscribed,
				records: sorted(cl.visible),
				pending: cl.speculative.map((m) => ({ text: `${m.id}: ${m.ops.map(fmtOp).join(", ")}`, detail: `undo: ${m.undo.map(fmtOp).join(", ")}` })),
				pendingLabel: "Unconfirmed writes",
			}
		}
		return {
			clients: { client1: client("client1"), client2: client("client2") },
			server: {
				records: sorted(this.server.records),
				facts: CLIENTS.map((c) => {
					const sc = this.server.clients[`${c}#${this.clients[c].gen}`]
					return `${c}: stored ack ${sc?.ack ?? "none"} · keys sent [${listKeys(sc?.synced ?? [])}]`
				}),
			},
			...step,
		}
	}

	serverRecords() { return sorted(this.server.records) }
	clientRecords(c: ClientName) { return sorted(this.clients[c].visible) }
}

// ─── Proposed: Replicache-style base + pending ────────────────────────────
type ProposedMutation = { id: number; ops: Op[] }
type ProposedClient = {
	up: boolean
	subscribed: boolean
	base: Records
	pending: ProposedMutation[]
	counter: number
	cookie?: number
}

class ProposedWorld implements World {
	private server = {
		records: {} as Records,
		revision: 0,
		clients: {} as Record<ClientName, { synced?: string[]; lastMutationId: number }>,
	}
	private clients: Record<ClientName, ProposedClient> = {
		client1: { up: true, subscribed: false, base: {}, pending: [], counter: 0 },
		client2: { up: true, subscribed: false, base: {}, pending: [], counter: 0 },
	}

	private serverClient(c: ClientName) {
		return (this.server.clients[c] ??= { lastMutationId: 0 })
	}
	private visible(c: ClientName): Records {
		const cl = this.clients[c]
		const records = { ...cl.base }
		for (const m of cl.pending) for (const op of m.ops) applyOp(records, op)
		return records
	}
	private id(c: ClientName, n: number) { return `${short(c)}·m${n}` }

	apply(action: Action): Step {
		const messages: Message[] = []
		const notes: Note[] = []
		const c = action.c
		const cl = this.clients[c]
		switch (action.a) {
			case "subscribe":
				cl.subscribed = true
				break
			case "set":
				cl.pending.push({ id: ++cl.counter, ops: [{ type: "set", key: action.key, value: action.value }] })
				break
			case "remove":
				cl.pending.push({ id: ++cl.counter, ops: [{ type: "remove", key: action.key }] })
				notes.push({ kind: "info", text: "The remove is recorded by key, with no undo value" })
				break
			case "push": {
				if (cl.pending.length === 0) {
					notes.push({ kind: "info", text: `${c} has nothing pending` })
					break
				}
				const ms = cl.pending
				const label = `push ${ms.map((m) => this.id(c, m.id)).join(", ")}`
				if (action.lost) {
					messages.push({ from: c, to: "server", label, lost: true })
					notes.push({ kind: "good", text: `The push failed, so ${ids(ms.map((m) => this.id(c, m.id)))} ${ms.length > 1 ? "stay" : "stays"} pending and will be retried` })
					break
				}
				messages.push({ from: c, to: "server", label })
				const sc = this.serverClient(c)
				for (const m of ms) {
					if (m.id <= sc.lastMutationId) continue
					for (const op of m.ops) applyOp(this.server.records, op)
					sc.lastMutationId = m.id
				}
				this.server.revision++
				break
			}
			case "pull":
				this.pull(c, messages, notes)
				break
			case "crash":
				cl.up = false
				if (cl.pending.length)
					notes.push({ kind: "good", text: `Storage keeps the base and pending ${cl.pending.map((m) => this.id(c, m.id)).join(", ")}` })
				break
			case "restart":
				cl.up = true
				if (cl.pending.length)
					notes.push({ kind: "good", text: `Restarts with the same client id and pending ${cl.pending.map((m) => this.id(c, m.id)).join(", ")}` })
				break
		}
		return { messages, notes }
	}

	private pull(c: ClientName, messages: Message[], notes: Note[]) {
		const cl = this.clients[c]
		const sc = this.serverClient(c)
		const shouldRead = sc.synced === undefined || cl.cookie !== this.server.revision
		const current = shouldRead && cl.subscribed ? Object.keys(this.server.records).sort() : []
		const remove = shouldRead ? (sc.synced ?? []).filter((k) => !current.includes(k)) : []
		const set = current.map((k) => [k, this.server.records[k]!] as const)
		if (shouldRead) sc.synced = current
		cl.cookie = this.server.revision
		const last = sc.lastMutationId
		messages.push({ from: c, to: "server", label: "pull" })
		messages.push({
			from: "server",
			to: c,
			label: `set [${listKeys(set.map(([k]) => k))}] · remove [${listKeys(remove)}] · lastMutationId ${last}`,
		})
		for (const [k, v] of set) cl.base[k] = v
		for (const k of remove) delete cl.base[k]
		const confirmed = cl.pending.filter((m) => m.id <= last)
		cl.pending = cl.pending.filter((m) => m.id > last)
		if (confirmed.length) {
			const empty = set.length === 0 && remove.length === 0
			notes.push({ kind: "good", text: `${ids(confirmed.map((m) => this.id(c, m.id)))} confirmed${empty ? ", even though the patch is empty" : ""}` })
		}
		notes.push({ kind: "info", text: "Rebuild: base (server state) + pending writes. Nothing is undone" })
	}

	snapshot(step: Step): Snapshot {
		const client = (c: ClientName): ClientView => {
			const cl = this.clients[c]
			return {
				up: cl.up,
				subscribed: cl.subscribed,
				records: sorted(this.visible(c)),
				pending: cl.pending.map((m) => ({ text: `${this.id(c, m.id)}: ${m.ops.map(fmtOp).join(", ")}` })),
				pendingLabel: "Pending writes",
				base: sorted(cl.base),
			}
		}
		return {
			clients: { client1: client("client1"), client2: client("client2") },
			server: {
				records: sorted(this.server.records),
				facts: CLIENTS.map((c) => `${c}: lastMutationId ${this.server.clients[c]?.lastMutationId ?? 0}`),
			},
			...step,
		}
	}

	serverRecords() { return sorted(this.server.records) }
	clientRecords(c: ClientName) { return sorted(this.visible(c)) }
}

export function createWorld(model: Model): World {
	return model === "current" ? new CurrentWorld() : new ProposedWorld()
}
