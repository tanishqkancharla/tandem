import fs from "node:fs"
import path from "node:path"
import util from "node:util"
import { matchBy } from "@tanishqkancharla/tandem-core"
import * as errore from "errore"
import {
	aggregateCoverage,
	type DstCoverage,
	missingCoverage,
} from "./DstCoverage.js"
import type { DstRecoveryResult } from "./DstRecovery.js"
import type { DstTabCoverage } from "./DstTabs.js"
import { jsonlFileSink, parseArtifact, replay } from "./DstReplay.js"
import {
	type DstRunOptions,
	DstSimulation,
	type DstViolation,
	resolveRunOptions,
} from "./DstSimulation.js"

export class DstRunError extends errore.createTaggedError({
	name: "DstRunError",
	message: "seed $seed threw",
}) {}

export type DstSweepRun =
	| ({
			seed: number
			coverage: DstCoverage
			tabCoverage?: DstTabCoverage
			recovery: DstRecoveryResult
	  } & (
			| { outcome: "ok" }
			| {
					outcome: "violation"
					violation: DstViolation
					artifact: string
			  }
			| {
					outcome: "budgetExceeded"
					artifact: string
					violation?: DstViolation
			  }
			/** The recorded failure did not reproduce. */
			| { outcome: "nondeterministic"; artifact: string; detail: string }
	  ))
	/** The run threw: a harness bug, not a sync bug. */
	| { seed: number; outcome: "error"; artifact: string; detail: string }

/**
 * Runs `runs` consecutive seeds starting at `seed`. Each run streams its
 * artifact into `outDir`; artifacts are kept only for runs that fail, and every
 * failing run (including budget exhaustion and harness errors) is replayed.
 */
export async function sweep({
	runs,
	outDir,
	...options
}: DstRunOptions & { runs: number; outDir: string }): Promise<DstSweepRun[]> {
	fs.mkdirSync(outDir, { recursive: true })
	const results: DstSweepRun[] = []
	for (let index = 0; index < runs; index++) {
		const seed = options.seed + index
		const artifact = path.join(outDir, `seed-${seed}.jsonl`)
		const result = await new DstSimulation({ ...options, seed })
			.execute(jsonlFileSink(artifact))
			.catch((cause) => new DstRunError({ seed: String(seed), cause }))
		if (
			!(result instanceof Error) &&
			!result.violation &&
			result.recovery.ordinary !== "budgetExceeded"
		) {
			fs.rmSync(artifact)
			results.push({
				seed,
				outcome: "ok",
				coverage: result.coverage,
				tabCoverage: result.tabCoverage,
				recovery: result.recovery,
			})
			continue
		}
		const recorded = errore.try({
			try: () => parseArtifact(fs.readFileSync(artifact, "utf8")),
			catch: (cause) => new DstRunError({ seed: String(seed), cause }),
		})
		const replayed =
			recorded instanceof Error
				? recorded
				: await replay(recorded).catch(
						(cause) => new DstRunError({ seed: String(seed), cause }),
					)
		if (result instanceof Error) {
			results.push({
				seed,
				outcome: "error",
				artifact,
				detail: `${String(result.cause)}; replay: ${
					replayed instanceof Error
						? String(replayed.cause)
						: replayed.divergence
							? `diverged at step ${replayed.divergence.step}: ${replayed.divergence.reason}`
							: "recorded prefix replayed"
				}`,
			})
			continue
		}
		const completed = {
			seed,
			coverage: result.coverage,
			tabCoverage: result.tabCoverage,
			recovery: result.recovery,
		}
		if (
			replayed instanceof Error ||
			replayed.divergence ||
			!util.isDeepStrictEqual(replayed.violation, result.violation) ||
			!util.isDeepStrictEqual(replayed.recovery, result.recovery)
		) {
			results.push({
				...completed,
				outcome: "nondeterministic",
				artifact,
				detail:
					replayed instanceof Error
						? `replay threw: ${String(replayed.cause)}`
						: replayed.divergence
							? `diverged at step ${replayed.divergence.step}: ${replayed.divergence.reason}`
							: "replayed to a different violation or recovery outcome",
			})
			continue
		}
		if (result.recovery.ordinary === "budgetExceeded") {
			results.push({
				...completed,
				outcome: "budgetExceeded",
				violation: result.violation,
				artifact,
			})
			continue
		}
		if (result.violation) {
			results.push({
				...completed,
				outcome: "violation",
				violation: result.violation,
				artifact,
			})
		}
	}
	return results
}

export function describeViolation(violation: DstViolation): string {
	if ("detail" in violation) return `${violation.kind}: ${violation.detail}`
	if (violation.kind === "movedBackwards") {
		return [
			`${violation.client} moved ${violation.id} backwards at step ${violation.step}`,
			`  shown:    ${violation.shown?.text ?? "(absent)"}`,
			`  previous: ${violation.previous?.text ?? "(absent)"}`,
		].join("\n")
	}
	return [
		`${violation.client}/${violation.subscriptionId}: ${violation.kind} at ${violation.checkpoint}`,
		`  query: ${JSON.stringify(violation.spec)}`,
		`  expected: ${JSON.stringify(violation.expected)}`,
		`  actual:   ${JSON.stringify(violation.actual)}`,
	].join("\n")
}

/** A Markdown summary of a sweep, for a CI job summary. */
export function sweepSummary(
	options: DstRunOptions & {
		runs: number
		requireCoverage?: Parameters<typeof missingCoverage>[1]
	},
	results: readonly DstSweepRun[],
): string {
	const workload = resolveRunOptions(options)
	const count = (outcome: DstSweepRun["outcome"]) =>
		results.filter((result) => result.outcome === outcome).length
	const failures = results.filter((result) => result.outcome !== "ok")
	const completed = results.filter((result) => result.outcome !== "error")
	const coverage = aggregateCoverage(completed.map((result) => result.coverage))
	const missing = missingCoverage(coverage, options.requireCoverage ?? "all")
	const tabCoverage = completed.reduce<DstTabCoverage | undefined>(
		(total, result) => {
			if (!result.tabCoverage) return total
			const next = total ?? {
				takeoversWithPendingCommits: 0,
				acceptedPushRepliesLost: 0,
				failedSaves: 0,
				serverCompletions: 0,
				successfulCommits: 0,
				operations: {},
				batchSizes: {},
			}
			for (const key of [
				"takeoversWithPendingCommits",
				"acceptedPushRepliesLost",
				"failedSaves",
				"serverCompletions",
				"successfulCommits",
			] as const)
				next[key] += result.tabCoverage[key]
			for (const [key, count] of Object.entries(result.tabCoverage.operations))
				next.operations[key] = (next.operations[key] ?? 0) + count
			for (const [key, count] of Object.entries(result.tabCoverage.batchSizes))
				next.batchSizes[key] = (next.batchSizes[key] ?? 0) + count
			return next
		},
		undefined,
	)
	return [
		`### DST sweep: seeds ${options.seed}–${options.seed + options.runs - 1}`,
		"",
		`${options.steps} steps, fault rate ${options.faultRate ?? 0}, crash rate ${options.crashRate ?? 0}.`,
		`${workload.clientCount} clients and ${workload.tabs} shared tabs, ${workload.recordCount} ids per pool, max ${workload.maxMutationsInFlight} mutations in flight, shared write rate ${workload.sharedWriteRate}.`,
		`Initial subscriptions ${workload.initialSubscriptions}, subscription rate ${workload.subscriptionRate}, connectivity rate ${workload.connectivityRate}, recovery budget ${workload.recoveryEvents} events.`,
		"",
		`| ok | violation | budgetExceeded | nondeterministic | error |`,
		`|---|---|---|---|---|`,
		`| ${count("ok")} | ${count("violation")} | ${count("budgetExceeded")} | ${count("nondeterministic")} | ${count("error")} |`,
		"",
		"Recovery (completed runs):",
		`- ordinary: ${["passed", "budgetExceeded", "viewMismatch", "notRun"].map((status) => `${status} ${completed.filter(({ recovery }) => recovery.ordinary === status).length}`).join(", ")}`,
		`- repaired: ${["passed", "viewMismatch"].map((status) => `${status} ${completed.filter(({ recovery }) => recovery.repaired === status).length}`).join(", ")}`,
		"",
		"Aggregate executed coverage:",
		"```json",
		JSON.stringify(coverage, null, 2),
		"```",
		...(tabCoverage
			? [
					"Tab coverage:",
					"```json",
					JSON.stringify(tabCoverage, null, 2),
					"```",
				]
			: []),
		`Missing ${options.requireCoverage ?? "all"} coverage${options.requireCoverage ? " (required)" : " (informational)"}: ${missing.length > 0 ? missing.join(", ") : "none"}.`,
		"",
		...failures.map((failure) => {
			const detail = matchBy(failure, "outcome", {
				violation: ({ violation }) =>
					describeViolation(violation).split("\n")[0],
				budgetExceeded: ({ recovery, violation }) =>
					`ordinary recovery budget exhausted after ${recovery.eventsDelivered} events; repaired ${recovery.repaired}${violation ? `; ${describeViolation(violation).split("\n")[0]}` : ""}`,
				nondeterministic: ({ detail }) => detail,
				error: ({ detail }) => detail,
			})
			return `- seed ${failure.seed} (${failure.outcome}): ${detail}\n  - artifact: ${failure.artifact}\n  - replay: \`pnpm dst:run --replay '${failure.artifact.replaceAll("'", "'\\''")}'\``
		}),
		"",
	].join("\n")
}
