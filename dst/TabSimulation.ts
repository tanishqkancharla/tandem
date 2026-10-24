import {
	appendFileSync,
	mkdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs"
import { join } from "node:path"
import { matchBy } from "@tanishqkancharla/tandem-core"
import * as errore from "errore"
import { SimPrng } from "./SimPrng.js"
import {
	type TabCoverage,
	type TabIntent,
	type TabOutcome,
	type TabPendingStep,
	type TabTraceRecord,
	type TabViolation,
	TabWorld,
} from "./TabWorld.js"

export type {
	TabCoverage,
	TabOutcome,
	TabTraceRecord,
	TabViolation,
} from "./TabWorld.js"
export { TabWorld } from "./TabWorld.js"

export interface TabRunOptions {
	seed: number
	steps: number
	/** Chance per step of losing a network request, reply, or poke. */
	faultRate?: number
	/** Chance per step of failing a pending leader storage commit. */
	saveFaultRate?: number
	/** Chance per step that a live tab crashes. */
	crashRate?: number
}

export type TabRunResult = {
	seed: number
	trace: readonly TabTraceRecord[]
} & TabOutcome

/** One line of a tab run's JSONL artifact: a header, one event per step, then the outcome. */
export type TabArtifactLine =
	| { kind: "header"; format: 1; mode: "tabs"; options: TabRunOptions }
	| ({ kind: "event" } & TabTraceRecord)
	| ({ kind: "outcome" } & TabOutcome)

export type TabArtifactSink = { write(line: TabArtifactLine): void }

export type TabArtifact = {
	options: TabRunOptions
	trace: TabTraceRecord[]
	outcome?: TabOutcome
}

const maxTabs = 3
/** A new write or flush starts only while fewer steps than this are pending. */
const maxStepsPending = 10
const mutateRate = 0.3
const flushRate = 0.1
const openRate = 0.03
const closeRate = 0.01
const toggleRate = 0.03
/** Chance that the leader crashes soon after a failed save, once tabs may have heard of it. */
const crashAfterFailedSave = 0.5

/** A random run over shared tabs: each step applies one event possible now. */
export class TabSimulation {
	// Steps left until the leader crashes after a failed save.
	private crashCountdown: number | undefined

	constructor(private readonly options: TabRunOptions) {}

	async execute(sink?: TabArtifactSink): Promise<TabRunResult> {
		const { seed, steps } = this.options
		sink?.write({
			kind: "header",
			format: 1,
			mode: "tabs",
			options: this.options,
		})
		await using world = TabWorld.start(seed)
		const rng = new SimPrng(seed)
		const trace: TabTraceRecord[] = []
		await world.settle()
		for (let step = 0; step < steps; step++) {
			const intent = this.choose(rng, world, world.pending())
			if (intent) {
				const record = world.apply(step, intent)
				trace.push(record)
				sink?.write({ kind: "event", ...record })
			}
			await world.settle()
		}
		const outcome = await world.finish()
		sink?.write({ kind: "outcome", ...outcome })
		return { seed, trace, ...outcome }
	}

	private choose(
		rng: SimPrng,
		world: TabWorld,
		pending: readonly TabPendingStep[],
	): TabIntent | undefined {
		const faultRate = this.options.faultRate ?? 0
		const saveFaultRate = this.options.saveFaultRate ?? 0
		const crashRate = this.options.crashRate ?? 0
		const { alive, writers, leader } = world
		if (this.crashCountdown !== undefined && --this.crashCountdown <= 0) {
			this.crashCountdown = undefined
			if (leader) return { type: "crash", tab: leader }
		}
		if (alive.length === 0 || (alive.length < maxTabs && rng.boolean(openRate)))
			return { type: "open" }
		if (crashRate > 0 && rng.boolean(crashRate))
			return { type: "crash", tab: rng.pick(alive).name }
		if (alive.length > 1 && rng.boolean(closeRate))
			return { type: "close", tab: rng.pick(alive).name }
		const lossy = pending.filter(
			({ kind, faultable }) => faultable && kind !== "storage",
		)
		if (faultRate > 0 && lossy.length > 0 && rng.boolean(faultRate))
			return { type: "fault", call: rng.pick(lossy).name }
		const saves = pending.filter(
			({ kind, faultable }) => faultable && kind === "storage",
		)
		if (saveFaultRate > 0 && saves.length > 0 && rng.boolean(saveFaultRate)) {
			if (
				this.crashCountdown === undefined &&
				rng.boolean(crashAfterFailedSave)
			)
				this.crashCountdown = rng.int(2, 12)
			return { type: "fault", call: rng.pick(saves).name }
		}
		if (
			writers.length > 0 &&
			(pending.length === 0 ||
				(pending.length < maxStepsPending && rng.boolean(mutateRate)))
		) {
			const tab = rng.pick(writers).name
			if (rng.boolean(toggleRate)) return { type: "toggle", tab }
			return rng.boolean(flushRate)
				? { type: "flush", tab }
				: { type: "write", tab }
		}
		if (pending.length > 0)
			return { type: "advance", call: rng.pick(pending).name }
		return undefined
	}
}

/** Where a replay left the recorded path. */
export type TabDivergence = {
	step: number
	expected: TabTraceRecord
	actual?: TabTraceRecord
	reason: string
}

export type TabReplayResult = {
	outcome?: TabOutcome
	divergence?: TabDivergence
}

/** Re-applies a recorded run's events with no random choices. */
export async function replayTabs(
	artifact: TabArtifact,
): Promise<TabReplayResult> {
	await using world = TabWorld.start(artifact.options.seed)
	await world.settle()
	const events = new Map(artifact.trace.map((record) => [record.step, record]))
	for (let step = 0; step < artifact.options.steps; step++) {
		const expected = events.get(step)
		if (expected) {
			const reason = cannotApply(world, expected)
			if (reason) return { divergence: { step, expected, reason } }
			const actual = world.apply(step, intentOf(expected))
			if (JSON.stringify(actual) !== JSON.stringify(expected))
				return {
					divergence: {
						step,
						expected,
						actual,
						reason: "the event applied differently",
					},
				}
		}
		await world.settle()
	}
	return { outcome: await world.finish() }
}

function cannotApply(world: TabWorld, record: TabTraceRecord) {
	switch (record.type) {
		case "open":
			return
		case "advance":
		case "fault":
			return world.hasPending(record.call)
				? undefined
				: `${record.call} is not pending`
		case "write":
		case "flush":
		case "toggle":
			return world.writers.some(({ name }) => name === record.tab)
				? undefined
				: `${record.tab} cannot take writes`
		case "close":
			return world.alive.some(({ name }) => name === record.tab)
				? undefined
				: `${record.tab} is not open`
		case "crash":
			return world.running.some(({ name }) => name === record.tab)
				? undefined
				: `${record.tab} is not running`
	}
}

function intentOf(record: TabTraceRecord): TabIntent {
	switch (record.type) {
		case "open":
			return { type: "open" }
		case "close":
		case "crash":
		case "write":
		case "flush":
		case "toggle":
			return { type: record.type, tab: record.tab }
		case "advance":
		case "fault":
			return { type: record.type, call: record.call }
	}
}

export function tabMemorySink(): TabArtifactSink & {
	lines: TabArtifactLine[]
} {
	const lines: TabArtifactLine[] = []
	return { lines, write: (line) => lines.push(line) }
}

export function tabFileSink(path: string): TabArtifactSink {
	writeFileSync(path, "")
	return {
		write: (line) => appendFileSync(path, `${JSON.stringify(line)}\n`),
	}
}

export function parseTabArtifact(jsonl: string): TabArtifact {
	const lines = jsonl
		.split("\n")
		.filter((line) => line.trim() !== "")
		.map((line) => JSON.parse(line) as TabArtifactLine)
	const header = lines[0]
	if (header?.kind !== "header" || header.mode !== "tabs")
		throw new Error("A tab DST artifact must start with its tabs header")
	const trace: TabTraceRecord[] = []
	let outcome: TabOutcome | undefined
	for (const line of lines.slice(1)) {
		if (line.kind === "event") {
			const { kind: _kind, ...record } = line
			trace.push(record as TabTraceRecord)
		} else if (line.kind === "outcome") {
			const { kind: _kind, ...rest } = line
			outcome = rest
		}
	}
	return { options: header.options, trace, outcome }
}

export type TabSweepRun =
	| { seed: number; outcome: "ok"; coverage: TabCoverage }
	| {
			seed: number
			outcome: "violation"
			violation: TabViolation
			artifact: string
			coverage: TabCoverage
	  }
	/** The run's artifact did not replay to the same outcome. */
	| {
			seed: number
			outcome: "nondeterministic"
			artifact: string
			detail: string
	  }
	/** The run threw: a harness bug, not a sync bug. */
	| { seed: number; outcome: "error"; artifact: string; detail: string }

/**
 * Runs `runs` consecutive seeds from `seed`, keeping artifacts only for runs
 * that fail. Every violating run must replay to the same violation.
 */
export async function sweepTabs({
	runs,
	outDir,
	...options
}: TabRunOptions & { runs: number; outDir: string }): Promise<TabSweepRun[]> {
	mkdirSync(outDir, { recursive: true })
	const results: TabSweepRun[] = []
	for (let index = 0; index < runs; index++) {
		const seed = options.seed + index
		const artifact = join(outDir, `tabs-seed-${seed}.jsonl`)
		const result = await new TabSimulation({ ...options, seed })
			.execute(tabFileSink(artifact))
			.catch((cause) => new TabRunError({ seed: String(seed), cause }))
		if (result instanceof Error) {
			results.push({
				seed,
				outcome: "error",
				artifact,
				detail: String(result.cause),
			})
			continue
		}
		if (!result.violation) {
			rmSync(artifact)
			results.push({ seed, outcome: "ok", coverage: result.coverage })
			continue
		}
		const replayed = await replayTabs(
			parseTabArtifact(readFileSync(artifact, "utf8")),
		)
		if (
			replayed.divergence ||
			JSON.stringify(replayed.outcome?.violation) !==
				JSON.stringify(result.violation)
		) {
			results.push({
				seed,
				outcome: "nondeterministic",
				artifact,
				detail: replayed.divergence
					? `diverged at step ${replayed.divergence.step}: ${replayed.divergence.reason}`
					: "replayed to a different violation",
			})
			continue
		}
		results.push({
			seed,
			outcome: "violation",
			violation: result.violation,
			artifact,
			coverage: result.coverage,
		})
	}
	return results
}

class TabRunError extends errore.createTaggedError({
	name: "TabRunError",
	message: "seed $seed threw",
}) {}

/** A Markdown summary of a tab sweep, including how often it reached each situation. */
export function tabSweepSummary(
	options: TabRunOptions & { runs: number },
	results: readonly TabSweepRun[],
): string {
	const count = (outcome: TabSweepRun["outcome"]) =>
		results.filter((result) => result.outcome === outcome).length
	const coverage: Record<string, number> = {}
	for (const result of results)
		if ("coverage" in result)
			for (const [key, value] of Object.entries(result.coverage))
				coverage[key] = (coverage[key] ?? 0) + value
	return [
		`### Tab DST sweep: seeds ${options.seed}–${options.seed + options.runs - 1}`,
		"",
		`${options.steps} steps, fault rate ${options.faultRate ?? 0}, save fault rate ${options.saveFaultRate ?? 0}, crash rate ${options.crashRate ?? 0}.`,
		"",
		`| ok | violation | nondeterministic | error |`,
		`|---|---|---|---|`,
		`| ${count("ok")} | ${count("violation")} | ${count("nondeterministic")} | ${count("error")} |`,
		"",
		`Coverage: ${Object.entries(coverage)
			.map(([key, value]) => `${key} ${value}`)
			.join(", ")}.`,
		"",
		...results.flatMap((result) =>
			matchBy(result, "outcome", {
				ok: () => [],
				violation: ({ seed, violation }) => [
					`- seed ${seed} (violation): ${violation.kind}: ${violation.detail}`,
				],
				nondeterministic: ({ seed, detail }) => [
					`- seed ${seed} (nondeterministic): ${detail}`,
				],
				error: ({ seed, detail }) => [`- seed ${seed} (error): ${detail}`],
			}),
		),
		"",
	].join("\n")
}
