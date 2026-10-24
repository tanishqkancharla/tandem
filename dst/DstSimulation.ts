import type { DstArtifactSink } from "./DstReplay.js"
import {
	type DstFinalStates,
	type DstTabCoverage,
	type DstIntent,
	type DstPendingCall,
	type DstTabName,
	type DstTraceRecord,
	type DstViolation,
	DstWorld,
	serverOwnedIds,
} from "./DstWorld.js"
import { SimPrng } from "./SimPrng.js"

export type {
	DstClientName,
	DstFaultKind,
	DstFinalStates,
	DstTabCoverage,
	DstSchema,
	DstTodo,
	DstTraceRecord,
	DstViolation,
} from "./DstWorld.js"
export { DstFaultError, dstSchemaDefinition } from "./DstWorld.js"

export interface DstRunOptions {
	seed: number
	steps: number
	faultRate?: number
	/** Chance per step that a running client or tab crashes. */
	crashRate?: number
	/** Browser tabs sharing one client storage, besides the two clients. */
	tabs?: number
}

export type DstRunResult = {
	seed: number
	stepsCompleted: number
	trace: readonly DstTraceRecord[]
	clientIds: readonly (string | null)[]
	states: DstFinalStates
	violation: DstViolation | undefined
	maxPendingCalls: number
	/** Present when the run had a tab group. */
	tabCoverage?: DstTabCoverage
}

/** A new mutation starts only while fewer calls than this are in flight. */
const maxCallsInFlight = 4
/** How often a step starts a mutation rather than advancing a pending call. */
const mutateRate = 0.35
/** Share of new writes the server makes itself rather than a client. */
const serverWriteRate = 0.4
/** Chance that a tab's step disconnects it, or reconnects it. */
const toggleTabRate = 0.05
/** Chance per step that a crashed client restarts. */
const restartRate = 0.25
const poolOfIds = ["item-1", "item-2", "item-3"]

/** A random run: each step applies one event chosen from what is possible now. */
export class DstSimulation {
	constructor(private readonly options: DstRunOptions) {}

	async execute(sink?: DstArtifactSink): Promise<DstRunResult> {
		const { seed, steps } = this.options
		sink?.write({ kind: "header", format: 1, options: this.options })
		await using world = await DstWorld.start(seed, { tabs: this.options.tabs })
		// Drives choices only; ids come from their own streams.
		const rng = new SimPrng(seed)
		const trace: DstTraceRecord[] = []

		const stepsCompleted = steps
		for (let step = 0; step < steps; step++) {
			const intent = this.choose(rng, world, world.pending(), step)
			if (intent) {
				const record = await world.apply(step, intent)
				trace.push(record)
				sink?.write({ kind: "event", ...record })
			}
			await world.settle()
		}

		const outcome = await world.finish()
		sink?.write({ kind: "outcome", stepsCompleted, ...outcome })
		return {
			seed,
			stepsCompleted,
			trace,
			...outcome,
			maxPendingCalls: world.maxPendingCalls,
		}
	}

	private choose(
		rng: SimPrng,
		world: DstWorld,
		pending: readonly DstPendingCall[],
		step: number,
	): DstIntent | undefined {
		const faultRate = this.options.faultRate ?? 0
		const crashRate = this.options.crashRate ?? 0
		// Faults model lost network messages and, in a tab group, failed saves of
		// forwarded writes; never a failed timer.
		const droppable = pending.filter(({ droppable }) => droppable)
		const { down, crashable, writers } = world

		// Without crashes these draw nothing, so crash-free runs are unchanged.
		if (down.length > 0 && rng.boolean(restartRate)) {
			return { type: "restart", client: rng.pick(down) }
		}
		// Without a tab group this draws nothing either.
		const tabs = this.options.tabs ?? 0
		if (
			tabs > 0 &&
			(world.tabs?.alive.length ?? 0) < tabs &&
			rng.boolean(restartRate)
		) {
			return { type: "openTab" }
		}
		if (crashRate > 0 && crashable.length > 0 && rng.boolean(crashRate)) {
			return { type: "crash", client: rng.pick(crashable) }
		}
		if (faultRate > 0 && droppable.length > 0 && rng.boolean(faultRate)) {
			return { type: "drop", call: rng.pick(droppable).name }
		}
		if (
			writers.length > 0 &&
			(pending.length === 0 ||
				(pending.length < maxCallsInFlight && rng.boolean(mutateRate)))
		) {
			if (rng.boolean(serverWriteRate)) {
				// Mostly its own records, as an agent streaming replies would, but
				// also ones clients share, so writers conflict.
				const id = rng.pick(rng.boolean(0.7) ? serverOwnedIds : poolOfIds)
				if (rng.boolean(0.2)) return { type: "serverRemove", id }
				return {
					type: "serverSet",
					item: {
						id,
						text: `Server ${id} (rev ${step})`,
						done: rng.boolean(0.3),
						priority: rng.int(1, 5),
					},
				}
			}
			const client = rng.pick(writers)
			// Only tabs draw this, so runs without tabs are unchanged.
			if (client.startsWith("tab") && rng.boolean(toggleTabRate))
				return { type: "toggleTab", tab: client as DstTabName }
			const id = rng.pick(poolOfIds)
			if (rng.boolean(0.2)) return { type: "remove", client, id }
			// Only the server writes its own records.
			const todos = world
				.todosOf(client)
				.filter(({ id }) => !serverOwnedIds.includes(id))
			if (todos.length > 0 && rng.boolean(0.5)) {
				// Target the local view so updates carry intent, not mostly missing-record no-ops.
				const todo = rng.pick(todos)
				const text = `Updated ${todo.id} (rev ${step})`
				const done = !todo.done
				const priority = rng.int(1, 5)
				return {
					type: "update",
					client,
					id: todo.id,
					payload: rng.pick([
						{ text },
						{ done },
						{ priority },
						{ text, done },
						{ text, priority },
						{ done, priority },
					]),
				}
			}
			return {
				type: "set",
				client,
				item: {
					id,
					text: `Note ${id} (rev ${step})`,
					done: rng.boolean(0.3),
					priority: rng.int(1, 5),
				},
			}
		}
		if (pending.length > 0) {
			return { type: "advance", call: rng.pick(pending).name }
		}
		return undefined
	}
}
