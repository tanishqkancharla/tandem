import childProcess from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { describe, expect, it, onTestFinished } from "vitest"
import { sweep, sweepSummary } from "./DstCli.js"
import { aggregateCoverage } from "./DstCoverage.js"
import { parseArtifact, replay } from "./DstReplay.js"

function temporaryDirectory() {
	const directory = fs.mkdtempSync(path.join(os.tmpdir(), "dst-cli-"))
	onTestFinished(() => fs.rmSync(directory, { recursive: true }))
	return directory
}

describe("DST CLI coverage and recovery", () => {
	it("preserves tab coverage in sweep results and the summary", async () => {
		const options = {
			seed: 1,
			steps: 100,
			runs: 2,
			tabs: 2,
			outDir: temporaryDirectory(),
			connectivityRate: 0,
		}
		const results = await sweep(options)
		const successfulCommits = results.reduce(
			(total, result) =>
				total +
				(result.outcome === "error"
					? 0
					: (result.tabCoverage?.successfulCommits ?? 0)),
			0,
		)
		expect(results).toHaveLength(2)
		expect(successfulCommits).toBeGreaterThan(0)
		expect(sweepSummary(options, results)).toContain("Tab coverage:")
		expect(sweepSummary(options, results)).toContain(
			`"successfulCommits": ${successfulCommits}`,
		)
	})

	it("removes passing artifacts while summarizing aggregate executed coverage", async () => {
		const outDir = temporaryDirectory()
		const options = {
			seed: 1,
			steps: 10,
			runs: 2,
			outDir,
			connectivityRate: 0,
			subscriptionRate: 0,
		}

		const results = await sweep(options)
		const completed = results.filter((result) => result.outcome === "ok")
		const coverage = aggregateCoverage(
			completed.map((result) => result.coverage),
		)
		const summary = sweepSummary(
			{ ...options, requireCoverage: "faults" },
			results,
		)

		expect(completed).toHaveLength(2)
		expect(
			completed.every(
				({ recovery }) =>
					recovery.ordinary === "passed" && recovery.repaired === "passed",
			),
		).toBe(true)
		expect(fs.readdirSync(outDir)).toEqual([])
		expect(
			Object.values(coverage.operations).reduce(
				(total, count) => total + count,
				0,
			),
		).toBeGreaterThan(0)
		expect(summary).toContain(JSON.stringify(coverage, null, 2))
		expect(summary).toContain("ordinary: passed 2")
		expect(summary).toContain("repaired: passed 2")
		expect(summary).toContain(
			"Missing faults coverage (required): dropsByKind.requestLost",
		)
	})

	it("retains and replays budget exhaustion even when repaired views have no violation", async () => {
		const outDir = temporaryDirectory()
		const options = {
			seed: 1,
			steps: 1,
			runs: 1,
			outDir,
			initialSubscriptions: "none" as const,
			connectivityRate: 0,
			subscriptionRate: 0,
			recoveryEvents: 0,
		}

		const results = await sweep(options)
		const artifactPath = path.join(outDir, "seed-1.jsonl")
		const artifact = parseArtifact(fs.readFileSync(artifactPath, "utf8"))
		const replayed = await replay(artifact)
		const summary = sweepSummary(options, results)

		expect(results).toMatchObject([
			{
				outcome: "budgetExceeded",
				violation: undefined,
				recovery: {
					ordinary: "budgetExceeded",
					repaired: "passed",
					eventsDelivered: 0,
				},
			},
		])
		expect(replayed.divergence).toBeUndefined()
		expect(replayed.violation).toBeUndefined()
		expect(replayed.recovery?.ordinary).toBe("budgetExceeded")
		expect(summary).toContain(`pnpm dst:run --replay '${artifactPath}'`)
		expect(summary).toContain(
			"ordinary recovery budget exhausted after 0 events; repaired passed",
		)
	})

	it.each([false, true])(
		"continues after a first-seed violation and gates its exit with --fail-on-violation=%s",
		async (failOnViolation) => {
			const directory = temporaryDirectory()
			// Both seeds reproduce the scoped offset-view mismatch; the first
			// failure must not prevent the second seed from running.
			const result = childProcess.spawnSync(
				process.execPath,
				[
					"--import",
					"tsx",
					new URL("./cli.ts", import.meta.url).pathname,
					"--runs",
					"2",
					"--seed",
					"18",
					"--steps",
					"2000",
					"--client-count",
					"3",
					"--record-count",
					"5",
					"--max-mutations-in-flight",
					"8",
					"--initial-subscriptions",
					"scoped",
					"--subscription-rate",
					"0.15",
					"--connectivity-rate",
					"0",
					"--out-dir",
					directory,
					...(failOnViolation ? ["--fail-on-violation"] : []),
				],
				{ cwd: new URL(".", import.meta.url), encoding: "utf8" },
			)
			const artifactPath = path.join(directory, "seed-18.jsonl")
			const artifact = parseArtifact(fs.readFileSync(artifactPath, "utf8"))
			const replayed = await replay(artifact)

			expect(result.status, result.stderr).toBe(failOnViolation ? 1 : 0)
			expect(result.stdout).toContain("| 0 | 2 | 0 | 0 | 0 |")
			expect(result.stdout).toContain("seed 18 (violation)")
			expect(result.stdout).toContain("seed 19 (violation)")
			expect(result.stdout).toContain(`pnpm dst:run --replay '${artifactPath}'`)
			expect(fs.readdirSync(directory).sort()).toEqual([
				"seed-18.jsonl",
				"seed-19.jsonl",
			])
			expect(replayed).toEqual({
				stepsCompleted: 2000,
				violation: artifact.outcome?.violation,
				recovery: artifact.outcome?.recovery,
				divergence: undefined,
			})
			expect(replayed.violation).toMatchObject({
				kind: "subscriptionView",
				checkpoint: "ordinary",
			})
		},
	)

	it.each(["sweep", "single"] as const)(
		"fails budget-only CLI %s runs and artifact replay without --fail-on-violation",
		(mode) => {
			const directory = temporaryDirectory()
			const run = childProcess.spawnSync(
				process.execPath,
				[
					"--import",
					"tsx",
					new URL("./cli.ts", import.meta.url).pathname,
					...(mode === "sweep" ? ["--runs", "1"] : []),
					"--seed",
					"1",
					"--steps",
					"1",
					"--initial-subscriptions",
					"none",
					"--connectivity-rate",
					"0",
					"--subscription-rate",
					"0",
					"--recovery-events",
					"0",
					...(mode === "sweep"
						? ["--out-dir", "artifacts"]
						: ["--out", "artifacts/seed-1.jsonl"]),
				],
				{
					cwd: new URL(".", import.meta.url),
					encoding: "utf8",
					env: { ...process.env, INIT_CWD: directory },
				},
			)
			const replayed = childProcess.spawnSync(
				process.execPath,
				[
					"--import",
					"tsx",
					new URL("./cli.ts", import.meta.url).pathname,
					"--replay",
					"artifacts/seed-1.jsonl",
				],
				{
					cwd: new URL(".", import.meta.url),
					encoding: "utf8",
					env: { ...process.env, INIT_CWD: directory },
				},
			)

			expect(run.status, run.stderr).toBe(1)
			if (mode === "sweep") {
				expect(run.stdout).toContain("seed 1 (budgetExceeded)")
			} else {
				expect(run.stdout).toContain("ordinary budgetExceeded, repaired passed")
				expect(run.stdout).toContain("executed coverage:")
				expect(run.stdout).toContain(
					"replay:   pnpm dst:run --replay 'artifacts/seed-1.jsonl'",
				)
			}
			expect(replayed.status, replayed.stderr).toBe(1)
			expect(replayed.stdout).toContain(
				"ordinary budgetExceeded, repaired passed",
			)
			expect(replayed.stdout).toContain("no violation")
		},
	)

	it.each([undefined, "faults"] as const)(
		"only gates missing coverage when required: %s",
		(profile) => {
			const directory = temporaryDirectory()
			const result = childProcess.spawnSync(
				process.execPath,
				[
					"--import",
					"tsx",
					new URL("./cli.ts", import.meta.url).pathname,
					"--runs",
					"1",
					"--seed",
					"1",
					"--steps",
					"1",
					"--initial-subscriptions",
					"none",
					"--connectivity-rate",
					"0",
					"--subscription-rate",
					"0",
					...(profile ? ["--require-coverage", profile] : []),
					"--out-dir",
					directory,
				],
				{ cwd: new URL(".", import.meta.url), encoding: "utf8" },
			)

			expect(result.status, result.stderr).toBe(profile ? 1 : 0)
			expect(result.stdout).toContain("| 1 | 0 | 0 | 0 | 0 |")
			expect(result.stdout).toContain(
				profile
					? "Missing faults coverage (required): dropsByKind.requestLost"
					: "Missing all coverage (informational):",
			)
			expect(fs.readdirSync(directory)).toEqual([])
		},
	)

	it.each([
		["connectivity-rate", "-0.1"],
		["connectivity-rate", "1.1"],
		["recovery-events", "-1"],
		["recovery-events", "1.5"],
		["recovery-events", "9007199254740992"],
		["require-coverage", "unknown"],
	])("rejects invalid --%s=%s before running", (name, value) => {
		const result = childProcess.spawnSync(
			process.execPath,
			[
				"--import",
				"tsx",
				new URL("./cli.ts", import.meta.url).pathname,
				`--${name}=${value}`,
			],
			{ cwd: new URL(".", import.meta.url), encoding: "utf8" },
		)

		expect(result.status).toBe(2)
		expect(result.stderr).toContain(`--${name} must be`)
	})
})
