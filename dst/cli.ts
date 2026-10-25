/**
 * pnpm dst:run --seed 123 --steps 300 [--fault-rate 0.1] [--crash-rate 0.02] [--out path]
 * pnpm dst:run --replay path.jsonl
 * pnpm dst:run --runs 24 --seed 2026092800 --steps 300 [--out-dir tmp/dst] [--fail-on-violation]
 * Workload: --client-count 5 --record-count 20 --max-mutations-in-flight 8 --shared-write-rate 0.5
 */
import fs from "node:fs"
import path from "node:path"
import util from "node:util"
import { describeViolation, sweep, sweepSummary } from "./DstCli.js"
import { aggregateCoverage, missingCoverage } from "./DstCoverage.js"
import type { DstRecoveryResult } from "./DstRecovery.js"
import { jsonlFileSink, parseArtifact, replay } from "./DstReplay.js"
import { DstSimulation, resolveRunOptions } from "./DstSimulation.js"

const defaults = resolveRunOptions({ seed: 0, steps: 300 })
const { values } = util.parseArgs({
	options: {
		seed: { type: "string" },
		steps: { type: "string", default: String(defaults.steps) },
		"fault-rate": { type: "string", default: String(defaults.faultRate) },
		"crash-rate": { type: "string", default: String(defaults.crashRate) },
		"client-count": { type: "string", default: String(defaults.clientCount) },
		"record-count": { type: "string", default: String(defaults.recordCount) },
		"max-mutations-in-flight": {
			type: "string",
			default: String(defaults.maxMutationsInFlight),
		},
		"shared-write-rate": {
			type: "string",
			default: String(defaults.sharedWriteRate),
		},
		"initial-subscriptions": { type: "string", default: "scoped" },
		"subscription-rate": {
			type: "string",
			default: String(defaults.subscriptionRate),
		},
		"connectivity-rate": {
			type: "string",
			default: String(defaults.connectivityRate),
		},
		"recovery-events": { type: "string" },
		"require-coverage": { type: "string" },
		out: { type: "string" },
		replay: { type: "string" },
		runs: { type: "string" },
		"out-dir": { type: "string", default: "tmp/dst" },
		"fail-on-violation": { type: "boolean", default: false },
	},
})

// pnpm runs package scripts from the package directory; resolve paths against
// the directory the command was invoked from instead.
const invokedFrom = process.env.INIT_CWD ?? process.cwd()
const fromInvocation = (value: string) => path.resolve(invokedFrom, value)
const shown = (value: string) => path.relative(invokedFrom, value)

function number(name: string, value: string): number {
	const parsed = Number(value)
	if (!Number.isFinite(parsed)) {
		console.error(`--${name} must be a number, got ${value}`)
		process.exit(2)
	}
	return parsed
}

function positiveInteger(name: string, value: string): number {
	const parsed = number(name, value)
	if (!Number.isSafeInteger(parsed) || parsed < 1) {
		console.error(`--${name} must be a positive safe integer, got ${value}`)
		process.exit(2)
	}
	return parsed
}

function nonnegativeInteger(name: string, value: string): number {
	const parsed = number(name, value)
	if (!Number.isSafeInteger(parsed) || parsed < 0) {
		console.error(`--${name} must be a nonnegative safe integer, got ${value}`)
		process.exit(2)
	}
	return parsed
}

function probability(name: string, value: string): number {
	const parsed = number(name, value)
	if (parsed < 0 || parsed > 1) {
		console.error(`--${name} must be between 0 and 1, got ${value}`)
		process.exit(2)
	}
	return parsed
}

function subscriptionMode(value: string): "full" | "scoped" | "none" {
	if (value === "full" || value === "scoped" || value === "none") return value
	console.error("--initial-subscriptions must be full, scoped, or none")
	process.exit(2)
}

function coverageProfile(value: string): Parameters<typeof missingCoverage>[1] {
	if (
		value === "writes" ||
		value === "subscriptions" ||
		value === "faults" ||
		value === "crashes" ||
		value === "all"
	)
		return value
	console.error(
		"--require-coverage must be writes, subscriptions, faults, crashes, or all",
	)
	process.exit(2)
}

function printRecovery(recovery: DstRecoveryResult): void {
	console.log(
		`recovery: ordinary ${recovery.ordinary}, repaired ${recovery.repaired}, ${recovery.eventsDelivered} events delivered`,
	)
}

const requireCoverage =
	values["require-coverage"] === undefined
		? undefined
		: coverageProfile(values["require-coverage"])

if (values.replay) {
	const artifact = parseArtifact(
		fs.readFileSync(fromInvocation(values.replay), "utf8"),
	)
	console.log(`replaying ${values.replay}: seed ${artifact.options.seed}`)
	const result = await replay(artifact)
	if (result.recovery) printRecovery(result.recovery)
	if (result.divergence) {
		console.log(
			`diverged at step ${result.divergence.step}: ${result.divergence.reason}`,
		)
		process.exitCode = 1
	} else if (result.violation) {
		console.log(describeViolation(result.violation))
		process.exitCode = 1
	} else {
		console.log("no violation")
	}
	if (result.recovery?.ordinary === "budgetExceeded") process.exitCode = 1
} else {
	const options = {
		// A seed is always printed, so an unseeded run can still be reproduced.
		seed: number("seed", values.seed ?? String(Date.now() % 2 ** 31)),
		steps: positiveInteger("steps", values.steps),
		faultRate: probability("fault-rate", values["fault-rate"]),
		crashRate: probability("crash-rate", values["crash-rate"]),
		clientCount: positiveInteger("client-count", values["client-count"]),
		recordCount: positiveInteger("record-count", values["record-count"]),
		maxMutationsInFlight: positiveInteger(
			"max-mutations-in-flight",
			values["max-mutations-in-flight"],
		),
		sharedWriteRate: probability(
			"shared-write-rate",
			values["shared-write-rate"],
		),
		initialSubscriptions: subscriptionMode(values["initial-subscriptions"]),
		subscriptionRate: probability(
			"subscription-rate",
			values["subscription-rate"],
		),
		connectivityRate: probability(
			"connectivity-rate",
			values["connectivity-rate"],
		),
		...(values["recovery-events"] === undefined
			? {}
			: {
					recoveryEvents: nonnegativeInteger(
						"recovery-events",
						values["recovery-events"],
					),
				}),
	}

	if (values.runs !== undefined) {
		const runs = positiveInteger("runs", values.runs)
		const results = await sweep({
			...options,
			runs,
			outDir: fromInvocation(values["out-dir"]),
		})
		const summary = sweepSummary({ ...options, runs, requireCoverage }, results)
		console.log(summary)
		if (process.env.GITHUB_STEP_SUMMARY) {
			fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary)
		}
		const harnessFailed = results.some(
			({ outcome }) =>
				outcome === "error" ||
				outcome === "nondeterministic" ||
				outcome === "budgetExceeded",
		)
		const violated = results.some(({ outcome }) => outcome === "violation")
		const coverage = aggregateCoverage(
			results.flatMap((result) =>
				result.outcome === "error" ? [] : [result.coverage],
			),
		)
		const uncovered =
			requireCoverage !== undefined &&
			missingCoverage(coverage, requireCoverage).length > 0
		if (
			harnessFailed ||
			uncovered ||
			(violated && values["fail-on-violation"])
		) {
			process.exitCode = 1
		}
	} else {
		const out = fromInvocation(
			values.out ?? `tmp/dst/seed-${options.seed}.jsonl`,
		)
		fs.mkdirSync(path.dirname(out), { recursive: true })
		console.log(
			`seed ${options.seed}, ${options.steps} steps, ${options.clientCount} clients, ${options.recordCount} ids per pool, max ${options.maxMutationsInFlight} mutations in flight, shared write rate ${options.sharedWriteRate}, fault rate ${options.faultRate}, crash rate ${options.crashRate}`,
		)
		const result = await new DstSimulation(options).execute(jsonlFileSink(out))
		printRecovery(result.recovery)
		console.log(
			`executed coverage: ${JSON.stringify(result.coverage, null, 2)}`,
		)
		const missing = missingCoverage(result.coverage, requireCoverage ?? "all")
		console.log(
			`Missing ${requireCoverage ?? "all"} coverage${requireCoverage ? " (required)" : " (informational)"}: ${missing.length > 0 ? missing.join(", ") : "none"}.`,
		)
		if (result.violation) {
			console.log(describeViolation(result.violation))
		} else {
			console.log(`no violation in ${result.stepsCompleted} steps`)
		}
		if (
			result.violation ||
			result.recovery.ordinary === "budgetExceeded" ||
			(requireCoverage && missing.length > 0)
		) {
			console.log(`artifact: ${shown(out)}`)
			console.log(
				`replay:   pnpm dst:run --replay '${shown(out).replaceAll("'", "'\\''")}'`,
			)
			process.exitCode = 1
		}
	}
}
