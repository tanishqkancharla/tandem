import { appendFileSync, writeFileSync } from "node:fs"
import type { DstRunOptions } from "./DstSimulation.js"
import {
	type DstIntent,
	type DstOutcome,
	type DstTraceRecord,
	type DstViolation,
	DstWorld,
} from "./DstWorld.js"

/**
 * One line of a run's JSONL artifact: a header, then one event per applied
 * step, then the outcome. A run that hangs or throws leaves the lines it wrote.
 */
export type DstArtifactLine =
	| { kind: "header"; format: 1; options: DstRunOptions }
	| ({ kind: "event" } & DstTraceRecord)
	| ({ kind: "outcome"; stepsCompleted: number } & DstOutcome)

export type DstArtifactSink = { write(line: DstArtifactLine): void }

export type DstArtifact = {
	options: DstRunOptions
	trace: DstTraceRecord[]
	/** Missing when the run stopped before writing it. */
	outcome?: { stepsCompleted: number } & DstOutcome
}

/** Keeps lines in memory, for tests. */
export function memorySink(): DstArtifactSink & { lines: DstArtifactLine[] } {
	const lines: DstArtifactLine[] = []
	return { lines, write: (line) => lines.push(line) }
}

/** Appends each line to `path` as it is written, so a failed run leaves its trace. */
export function jsonlFileSink(path: string): DstArtifactSink {
	writeFileSync(path, "")
	return {
		write: (line) => appendFileSync(path, `${JSON.stringify(line)}\n`),
	}
}

export function formatArtifact(lines: readonly DstArtifactLine[]): string {
	return lines.map((line) => `${JSON.stringify(line)}\n`).join("")
}

export function parseArtifact(jsonl: string): DstArtifact {
	const lines = jsonl
		.split("\n")
		.filter((line) => line.trim() !== "")
		.map((line) => JSON.parse(line) as DstArtifactLine)
	const header = lines[0]
	if (header?.kind !== "header") {
		throw new Error("A DST artifact must start with its header")
	}
	const trace: DstTraceRecord[] = []
	let outcome: DstArtifact["outcome"]
	for (const line of lines.slice(1)) {
		if (line.kind === "event") {
			const { kind: _kind, ...record } = line
			trace.push(record as DstTraceRecord)
		} else if (line.kind === "outcome") {
			const { kind: _kind, ...rest } = line
			outcome = rest
		}
	}
	return { options: header.options, trace, outcome }
}

/** Where a replay left the recorded path: the recorded event could not apply as recorded. */
export type DstDivergence = {
	step: number
	expected: DstTraceRecord
	actual?: DstTraceRecord
	reason: string
}

export type DstReplayResult = {
	stepsCompleted: number
	violation: DstViolation | undefined
	divergence: DstDivergence | undefined
}

/**
 * Re-applies a recorded run's events, step by step, with no random choices.
 * Each event must apply exactly as recorded, including the boundary it acted
 * on and the ids it generated; otherwise the replay stops with a divergence.
 */
export async function replay(artifact: DstArtifact): Promise<DstReplayResult> {
	await using world = await DstWorld.start(artifact.options.seed)
	const events = new Map(artifact.trace.map((record) => [record.step, record]))
	const steps =
		artifact.outcome?.stepsCompleted ?? (artifact.trace.at(-1)?.step ?? -1) + 1

	let violation: DstViolation | undefined
	let stepsCompleted = steps
	for (let step = 0; step < steps; step++) {
		world.pending()
		const expected = events.get(step)
		if (expected) {
			const reason = cannotApply(world, expected)
			if (reason) {
				await world.drain()
				return {
					stepsCompleted: step,
					violation: undefined,
					divergence: { step, expected, reason },
				}
			}
			const actual = await world.apply(step, intentOf(expected))
			if (JSON.stringify(actual) !== JSON.stringify(expected)) {
				await world.drain()
				return {
					stepsCompleted: step,
					violation: undefined,
					divergence: {
						step,
						expected,
						actual,
						reason: "the event applied differently",
					},
				}
			}
		}
		violation = await world.check(step)
		if (violation) {
			stepsCompleted = step + 1
			break
		}
	}

	const outcome = await world.finish(violation)
	return { stepsCompleted, violation: outcome.violation, divergence: undefined }
}

function cannotApply(
	world: DstWorld,
	record: DstTraceRecord,
): string | undefined {
	switch (record.type) {
		case "advance":
		case "drop":
			return world.hasPending(record.call)
				? undefined
				: `${record.call} is not held at a boundary`
		case "set":
		case "remove":
			return world.writers.includes(record.client)
				? undefined
				: `${record.client} cannot take writes`
		case "crash":
			return world.running.includes(record.client)
				? undefined
				: `${record.client} is not running`
		case "restart":
			return world.down.includes(record.client)
				? undefined
				: `${record.client} is not down`
	}
}

function intentOf(record: DstTraceRecord): DstIntent {
	switch (record.type) {
		case "set":
			return { type: "set", client: record.client, item: record.item }
		case "remove":
			return { type: "remove", client: record.client, id: record.id }
		case "advance":
		case "drop":
			return { type: record.type, call: record.call }
		case "crash":
		case "restart":
			return { type: record.type, client: record.client }
	}
}
