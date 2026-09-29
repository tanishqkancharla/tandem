import { mkdirSync, readFileSync, rmSync } from "node:fs"
import { join } from "node:path"
import { matchBy } from "@tanishqkancharla/tandem-core"
import * as errore from "errore"
import { jsonlFileSink, parseArtifact, replay } from "./DstReplay.js"
import {
	type DstRunOptions,
	DstSimulation,
	type DstTodo,
	type DstViolation,
} from "./DstSimulation.js"

export class DstRunError extends errore.createTaggedError({
	name: "DstRunError",
	message: "seed $seed threw",
}) {}

export type DstSweepRun =
	| { seed: number; outcome: "ok" }
	| {
			seed: number
			outcome: "violation"
			violation: DstViolation
			artifact: string
	  }
	/** The run's artifact did not replay to the same violation: the harness is not deterministic. */
	| {
			seed: number
			outcome: "nondeterministic"
			artifact: string
			detail: string
	  }
	/** The run threw: a harness bug, not a sync bug. */
	| { seed: number; outcome: "error"; artifact: string; detail: string }

/**
 * Runs `runs` consecutive seeds starting at `seed`. Each run streams its
 * artifact into `outDir`; artifacts are kept only for runs that fail, and every
 * violating run is replayed from its artifact to confirm it reproduces.
 */
export async function sweep({
	runs,
	outDir,
	...options
}: DstRunOptions & { runs: number; outDir: string }): Promise<DstSweepRun[]> {
	mkdirSync(outDir, { recursive: true })
	const results: DstSweepRun[] = []
	for (let index = 0; index < runs; index++) {
		const seed = options.seed + index
		const artifact = join(outDir, `seed-${seed}.jsonl`)
		const result = await new DstSimulation({ ...options, seed })
			.execute(jsonlFileSink(artifact))
			.catch((cause) => new DstRunError({ seed: String(seed), cause }))
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
			results.push({ seed, outcome: "ok" })
			continue
		}
		const replayed = await replay(parseArtifact(readFileSync(artifact, "utf8")))
		if (
			replayed.divergence ||
			JSON.stringify(replayed.violation) !== JSON.stringify(result.violation)
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
		})
	}
	return results
}

function todos(list: readonly DstTodo[]): string {
	if (list.length === 0) return "(none)"
	return list.map(({ text }) => text).join(", ")
}

export function describeViolation(violation: DstViolation): string {
	switch (violation.kind) {
		case "clientState":
			return [
				`${violation.client} disagrees with the model at ${violation.step === "quiescence" ? "quiescence" : `step ${violation.step}`}`,
				`  expected: ${todos(violation.expected)}`,
				`  actual:   ${todos(violation.actual)}`,
			].join("\n")
		case "serverState":
			return [
				"the server disagrees with the model",
				`  expected: ${todos(violation.expected)}`,
				`  actual:   ${todos(violation.actual)}`,
			].join("\n")
		case "writeNeverAccepted":
			return `${violation.client}'s writes never reached the server: ${violation.mutationIds.join(", ")}`
	}
}

/** A Markdown summary of a sweep, for a CI job summary. */
export function sweepSummary(
	options: DstRunOptions & { runs: number },
	results: readonly DstSweepRun[],
): string {
	const count = (outcome: DstSweepRun["outcome"]) =>
		results.filter((result) => result.outcome === outcome).length
	const failures = results.filter(({ outcome }) => outcome !== "ok")
	return [
		`### DST sweep: seeds ${options.seed}–${options.seed + options.runs - 1}`,
		"",
		`${options.steps} steps, fault rate ${options.faultRate ?? 0}, crash rate ${options.crashRate ?? 0}.`,
		"",
		`| ok | violation | nondeterministic | error |`,
		`|---|---|---|---|`,
		`| ${count("ok")} | ${count("violation")} | ${count("nondeterministic")} | ${count("error")} |`,
		"",
		...failures.map((failure) => {
			const detail = matchBy(failure, "outcome", {
				ok: () => "",
				violation: ({ violation }) =>
					describeViolation(violation).split("\n")[0],
				nondeterministic: ({ detail }) => detail,
				error: ({ detail }) => detail,
			})
			return `- seed ${failure.seed} (${failure.outcome}): ${detail}`
		}),
		"",
	].join("\n")
}
