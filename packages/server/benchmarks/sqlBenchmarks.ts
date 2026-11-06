/**
 * Runs every SQL benchmark cell, one process at a time, in a shuffled order,
 * and keeps each cell's JSON, log, exit code, and machine load. A cell that
 * fails stays in the manifest; the run continues.
 *
 * TANDEM_POSTGRES_URL=postgres://... \
 * pnpm --filter tandem-dst exec tsx ../packages/server/benchmarks/sqlBenchmarks.ts <outDir>
 */
import { spawnSync } from "node:child_process"
import { mkdirSync, writeFileSync } from "node:fs"
import { freemem, loadavg } from "node:os"
import { join, resolve } from "node:path"
import { random } from "./sqlWorkload.js"

const outDir = resolve(process.argv[2]!)
mkdirSync(outDir, { recursive: true })
const here = import.meta.dirname

type Cell = { name: string; script: string; args: string[] }
const dialects = [
	"sqlite",
	...(process.env.TANDEM_POSTGRES_URL ? ["postgres"] : []),
]
const cells: Cell[] = [
	...dialects.flatMap((dialect) =>
		[1000, 10_000, 100_000].map((rows) => ({
			name: `query-${dialect}-${rows}`,
			script: "sqlQueries.ts",
			args: [
				dialect,
				String(rows),
				join(outDir, `query-${dialect}-${rows}.json`),
			],
		})),
	),
	...dialects.flatMap((dialect) =>
		[1000, 10_000].flatMap((rows) =>
			[5, 10].map((clients) => ({
				name: `sync-${dialect}-${rows}-${clients}`,
				script: "sqlSync.ts",
				args: [
					dialect,
					String(rows),
					String(clients),
					join(outDir, `sync-${dialect}-${rows}-${clients}.json`),
				],
			})),
		),
	),
]

const next = random(2026)
for (let index = cells.length - 1; index > 0; index--) {
	const other = Math.floor(next() * (index + 1))
	;[cells[index], cells[other]] = [cells[other]!, cells[index]!]
}

const manifest: unknown[] = []
for (const cell of cells) {
	const before = {
		at: new Date().toISOString(),
		loadavg: loadavg(),
		freeMemoryBytes: freemem(),
	}
	console.log(`${before.at} ${cell.name} load ${before.loadavg[0]!.toFixed(2)}`)
	const run = spawnSync("tsx", [join(here, cell.script), ...cell.args], {
		encoding: "utf8",
		env: process.env,
		maxBuffer: 64 * 1024 * 1024,
	})
	writeFileSync(
		join(outDir, `${cell.name}.log`),
		`${run.stdout}\n${run.stderr}`,
	)
	manifest.push({
		...cell,
		before,
		after: {
			at: new Date().toISOString(),
			loadavg: loadavg(),
			freeMemoryBytes: freemem(),
		},
		status: run.status,
		signal: run.signal,
	})
	writeFileSync(
		join(outDir, "manifest.json"),
		JSON.stringify(manifest, null, "\t"),
	)
	console.log(`  exit ${run.status} ${run.stdout.trim().split("\n").at(-1)}`)
}
