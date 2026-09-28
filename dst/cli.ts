/**
 * pnpm dst:run --seed 123 --steps 300 [--fault-rate 0.1] [--crash-rate 0.02] [--out path]
 * pnpm dst:run --replay path.jsonl
 * pnpm dst:run --runs 24 --seed 2026092800 --steps 300 [--out-dir tmp/dst] [--fail-on-violation]
 */
import { appendFileSync, mkdirSync, readFileSync } from "node:fs"
import { dirname, relative, resolve } from "node:path"
import { parseArgs } from "node:util"
import { describeViolation, sweep, sweepSummary } from "./DstCli.js"
import { jsonlFileSink, parseArtifact, replay } from "./DstReplay.js"
import { type DstRunOptions, DstSimulation } from "./DstSimulation.js"

const { values } = parseArgs({
	options: {
		seed: { type: "string" },
		steps: { type: "string", default: "300" },
		"fault-rate": { type: "string", default: "0" },
		"crash-rate": { type: "string", default: "0" },
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
	const options: DstRunOptions = {
		// A seed is always printed, so an unseeded run can still be reproduced.
		seed: number("seed", values.seed ?? String(Date.now() % 2 ** 31)),
		steps: number("steps", values.steps),
		faultRate: number("fault-rate", values["fault-rate"]),
		crashRate: number("crash-rate", values["crash-rate"]),
	}

	if (values.runs) {
		const runs = number("runs", values.runs)
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
			`seed ${options.seed}, ${options.steps} steps, fault rate ${options.faultRate}, crash rate ${options.crashRate}`,
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
