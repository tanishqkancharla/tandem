import type { DstArtifactSink } from "./DstReplay.js"
import {
	type DstFinalStates,
	type DstIntent,
	type DstPendingCall,
	type DstTraceRecord,
	type DstViolation,
	DstWorld,
	isNetworkHandoff,
	serverOwnedIds,
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
	clientCount?: number
	/** Number of ids in each shared or client-owned pool. */
	recordCount?: number
	maxMutationsInFlight?: number
	/** Chance of targeting the shared pool rather than the writer's own pool. */
	sharedWriteRate?: number
}

export function resolveRunOptions(
	options: DstRunOptions,
): Required<DstRunOptions> {
	return {
		seed: options.seed,
		steps: options.steps,
		faultRate: options.faultRate ?? 0,
		crashRate: options.crashRate ?? 0,
		clientCount: options.clientCount ?? 2,
		recordCount: options.recordCount ?? 3,
		maxMutationsInFlight: options.maxMutationsInFlight ?? 4,
		sharedWriteRate: options.sharedWriteRate ?? 1,
	}
}

export type DstRunResult = {
	seed: number
	stepsCompleted: number
	trace: readonly DstTraceRecord[]
	clientIds: readonly (string | null)[]
	states: DstFinalStates
	violation: DstViolation | undefined
	maxPendingCalls: number
	maxMutationsInFlight: number
}

/** How often a step starts a mutation rather than advancing a pending call. */
const mutateRate = 0.35
/** Share of new writes the server makes itself rather than a client. */
const serverWriteRate = 0.4
/** Chance per step that a crashed client restarts. */
const restartRate = 0.25

/** A random run: each step applies one event chosen from what is possible now. */
export class DstSimulation {
	private readonly options: Required<DstRunOptions>

	constructor(options: DstRunOptions) {
		this.options = resolveRunOptions(options)
	}

	async execute(sink?: DstArtifactSink): Promise<DstRunResult> {
		const { seed, steps } = this.options
		sink?.write({ kind: "header", format: 1, options: this.options })
		await using world = await DstWorld.start(this.options)
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
			maxMutationsInFlight: world.maxMutationsInFlight,
		}
	}

	private choose(
		rng: SimPrng,
		world: DstWorld,
		pending: readonly DstPendingCall[],
		step: number,
	): DstIntent | undefined {
		const {
			faultRate,
			crashRate,
			maxMutationsInFlight,
			recordCount,
			sharedWriteRate,
		} = this.options
		// Faults model lost network messages, never a failed timer or disk write.
		const droppable = pending.filter(isNetworkHandoff)
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
			world.mutationsInFlight < maxMutationsInFlight &&
			(pending.length === 0 || rng.boolean(mutateRate))
		) {
			if (rng.boolean(serverWriteRate)) {
				// Mostly its own records, as an agent streaming replies would, but
				// also ones clients share, so writers conflict.
				const id = rng.boolean(0.7)
					? rng.pick(serverOwnedIds)
					: `item-${rng.int(1, recordCount)}`
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
			const prefix = rng.boolean(sharedWriteRate) ? "item-" : `${client}-item-`
			const id = `${prefix}${rng.int(1, recordCount)}`
			if (rng.boolean(0.2)) return { type: "remove", client, id }
			const todos = world
				.todosOf(client)
				.filter((todo) => todo.id.startsWith(prefix))
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
