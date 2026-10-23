/**
 * pnpm dst:run --seed 123 --steps 300 [--fault-rate 0.1] [--crash-rate 0.02] [--out path]
 * pnpm dst:run --replay path.jsonl
 * pnpm dst:run --runs 24 --seed 2026092800 --steps 300 [--out-dir tmp/dst] [--fail-on-violation]
 * Workload: --client-count 5 --record-count 20 --max-mutations-in-flight 8 --shared-write-rate 0.5
 */
import { appendFileSync, mkdirSync, readFileSync } from "node:fs"
import { dirname, relative, resolve } from "node:path"
import { parseArgs } from "node:util"
import { describeViolation, sweep, sweepSummary } from "./DstCli.js"
import { jsonlFileSink, parseArtifact, replay } from "./DstReplay.js"
import { DstSimulation, resolveRunOptions } from "./DstSimulation.js"

const defaults = resolveRunOptions({ seed: 0, steps: 300 })
const { values } = parseArgs({
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
const fromInvocation = (path: string) => resolve(invokedFrom, path)
const shown = (path: string) => relative(invokedFrom, path)

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

function probability(name: string, value: string): number {
	const parsed = number(name, value)
	if (parsed < 0 || parsed > 1) {
		console.error(`--${name} must be between 0 and 1, got ${value}`)
		process.exit(2)
	}
	return parsed
}

if (values.replay) {
	const artifact = parseArtifact(
		readFileSync(fromInvocation(values.replay), "utf8"),
	)
	console.log(`replaying ${values.replay}: seed ${artifact.options.seed}`)
	const result = await replay(artifact)
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
	}

	if (values.runs !== undefined) {
		const runs = positiveInteger("runs", values.runs)
		const results = await sweep({
			...options,
			runs,
			outDir: fromInvocation(values["out-dir"]),
		})
		const summary = sweepSummary({ ...options, runs }, results)
		console.log(summary)
		if (process.env.GITHUB_STEP_SUMMARY) {
			appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary)
		}
		const harnessFailed = results.some(
			({ outcome }) => outcome === "error" || outcome === "nondeterministic",
		)
		const violated = results.some(({ outcome }) => outcome === "violation")
		if (harnessFailed || (violated && values["fail-on-violation"])) {
			process.exitCode = 1
		}
	} else {
		const out = fromInvocation(
			values.out ?? `tmp/dst/seed-${options.seed}.jsonl`,
		)
		mkdirSync(dirname(out), { recursive: true })
		console.log(
			`seed ${options.seed}, ${options.steps} steps, ${options.clientCount} clients, ${options.recordCount} ids per pool, max ${options.maxMutationsInFlight} mutations in flight, shared write rate ${options.sharedWriteRate}, fault rate ${options.faultRate}, crash rate ${options.crashRate}`,
		)
		const result = await new DstSimulation(options).execute(jsonlFileSink(out))
		if (result.violation) {
			console.log(describeViolation(result.violation))
			console.log(`artifact: ${shown(out)}`)
			console.log(`replay:   pnpm dst:run --replay ${shown(out)}`)
			process.exitCode = 1
		} else {
			console.log(`no violation in ${result.stepsCompleted} steps`)
		}
	}
}
