import type { DstArtifactSink } from "./DstReplay.js"
import {
	type DstFinalStates,
	type DstIntent,
	type DstPendingCall,
	type DstTraceRecord,
	type DstViolation,
	DstWorld,
	isTimerHandoff,
} from "./DstWorld.js"
import { SimPrng } from "./SimPrng.js"

export type {
	DstClientName,
	DstFaultKind,
	DstFinalStates,
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
	/** Chance per step that a running client crashes. */
	crashRate?: number
}

export type DstRunResult = {
	seed: number
	stepsCompleted: number
	trace: readonly DstTraceRecord[]
	clientIds: readonly (string | null)[]
	states: DstFinalStates
	violation: DstViolation | undefined
	maxPendingCalls: number
}

/** A new mutation starts only while fewer calls than this are in flight. */
const maxCallsInFlight = 4
/** How often a step starts a mutation rather than advancing a pending call. */
const mutateRate = 0.35
/** Chance per step that a crashed client restarts. */
const restartRate = 0.25
const poolOfIds = ["item-1", "item-2", "item-3"]

/** A random run: each step applies one event chosen from what is possible now. */
export class DstSimulation {
	constructor(private readonly options: DstRunOptions) {}

	async execute(sink?: DstArtifactSink): Promise<DstRunResult> {
		const { seed, steps } = this.options
		sink?.write({ kind: "header", format: 1, options: this.options })
		await using world = await DstWorld.start(seed)
		// Drives choices only; ids come from their own streams.
		const rng = new SimPrng(seed)
		const trace: DstTraceRecord[] = []

		let violation: DstViolation | undefined
		let stepsCompleted = steps
		for (let step = 0; step < steps; step++) {
			const intent = this.choose(rng, world, world.pending(), step)
			if (intent) {
				const record = await world.apply(step, intent)
				trace.push(record)
				sink?.write({ kind: "event", ...record })
			}
			// Stop at the first step that disagrees with the model, so the trace
			// ends where the bug happened.
			violation = await world.check(step)
			if (violation) {
				stepsCompleted = step + 1
				break
			}
		}

		const outcome = await world.finish(violation)
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
		// Faults model lost network messages, never a timer that fails to tick.
		const droppable = pending.filter((call) => !isTimerHandoff(call))
		const { down, running, writers } = world

		// Without crashes these draw nothing, so crash-free runs are unchanged.
		if (down.length > 0 && rng.boolean(restartRate)) {
			return { type: "restart", client: rng.pick(down) }
		}
		if (crashRate > 0 && running.length > 0 && rng.boolean(crashRate)) {
			return { type: "crash", client: rng.pick(running) }
		}
		if (faultRate > 0 && droppable.length > 0 && rng.boolean(faultRate)) {
			return { type: "drop", call: rng.pick(droppable).name }
		}
		if (
			writers.length > 0 &&
			(pending.length === 0 ||
				(pending.length < maxCallsInFlight && rng.boolean(mutateRate)))
		) {
			const client = rng.pick(writers)
			const id = rng.pick(poolOfIds)
			if (rng.boolean(0.2)) return { type: "remove", client, id }
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
