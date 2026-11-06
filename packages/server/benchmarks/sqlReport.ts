/**
 * Summarizes a sqlBenchmarks.ts run directory into markdown tables and CSV.
 *
 * pnpm --filter tandem-dst exec tsx ../packages/server/benchmarks/sqlReport.ts <runDir>
 *
 * Writes summary.md, queries.csv, and sync.csv next to the raw JSON.
 */
import { readdirSync, readFileSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"

const runDir = resolve(process.argv[2]!)
const files = readdirSync(runDir).filter((file) => file.endsWith(".json"))
const read = (file: string) =>
	JSON.parse(readFileSync(join(runDir, file), "utf8")) as Record<string, any>

function quantile(values: readonly number[], q: number) {
	if (!values.length) return Number.NaN
	const sorted = [...values].sort((left, right) => left - right)
	const position = (sorted.length - 1) * q
	const low = Math.floor(position)
	const high = Math.ceil(position)
	return sorted[low]! + (sorted[high]! - sorted[low]!) * (position - low)
}
const ms = (value: number) =>
	Number.isNaN(value) ? "n/a" : value < 10 ? value.toFixed(2) : value.toFixed(1)
const median = (values: readonly number[]) => quantile(values, 0.5)

const lines: string[] = []
const queryCsv = [
	"dialect,rows,config,workload,samples,median_ms,p95_ms,returned_rows,rows_decoded,statements,pushed,fallback,exact",
]
const syncCsv = [
	"dialect,rows,clients,reads,view,rounds,initial_median_ms,update_median_ms,update_p95_ms,update_samples,initial_statements,initial_rows_decoded,update_statements,update_rows_decoded,exact",
]

const queryRuns = files
	.filter((file) => file.startsWith("query-"))
	.map(read)
	.sort((left, right) =>
		left.dialect === right.dialect
			? left.rows - right.rows
			: String(left.dialect).localeCompare(right.dialect),
	)

for (const run of queryRuns) {
	lines.push(
		`### ${run.dialect} ${run.database}, ${run.rows.toLocaleString("en-US")} messages`,
		"",
		`Seeded in ${(run.seedMs / 1000).toFixed(1)} s. ${run.rounds} rounds, ${run.samples} samples per workload per configuration per round, ${run.warmups} warm-ups. Commit ${String(run.commit).slice(0, 10)}${run.dirty ? " (dirty)" : ""}. Load before ${run.machineBefore.loadavg.map((value: number) => value.toFixed(2)).join(" ")}, after ${run.machineAfter?.loadavg.map((value: number) => value.toFixed(2)).join(" ") ?? "n/a"}. Inexact samples: ${run.failures.length}.`,
		"",
		"Median ms (p95) per configuration. Rows decoded counts rows SQL returned to Tandem, not rows the database examined.",
		"",
		"| Workload | Whole tables | SQL, PK only | SQL, 1 index | SQL, 2 indexes | Rows decoded (whole / SQL 1 index) | Statements (SQL) | Returned rows |",
		"| --- | --- | --- | --- | --- | --- | --- | --- |",
	)
	const samples = run.samplesRaw as Record<string, any>[]
	const workloads = [...new Set(samples.map((sample) => sample.workload))]
	for (const workload of workloads) {
		const cell = (config: string) =>
			samples.filter(
				(sample) => sample.workload === workload && sample.config === config,
			)
		const timing = (config: string) => {
			const values = cell(config).map((sample) => sample.ms)
			return `${ms(median(values))} (${ms(quantile(values, 0.95))})`
		}
		for (const config of ["fullReads", "sql0", "sql1", "sql2"]) {
			const values = cell(config)
			const first = values[0]!
			queryCsv.push(
				[
					run.dialect,
					run.rows,
					config,
					workload,
					values.length,
					median(values.map((sample) => sample.ms)).toFixed(3),
					quantile(
						values.map((sample) => sample.ms),
						0.95,
					).toFixed(3),
					first.returnedRows,
					median(values.map((sample) => sample.rowsDecoded)),
					median(values.map((sample) => sample.statements)),
					median(values.map((sample) => sample.pushed)),
					median(values.map((sample) => sample.fallback)),
					values.every((sample) => sample.exact),
				].join(","),
			)
		}
		const sql1 = cell("sql1")[0]!
		lines.push(
			`| ${workload} | ${timing("fullReads")} | ${timing("sql0")} | ${timing("sql1")} | ${timing("sql2")} | ${cell("fullReads")[0]!.rowsDecoded} / ${sql1.rowsDecoded} | ${sql1.statements} (${sql1.pushed} SQL, ${sql1.fallback} scan) | ${sql1.returnedRows} |`,
		)
	}
	const builds = run.indexBuilds as Record<string, any>[]
	lines.push(
		"",
		"| Index | Build ms (median) | Size |",
		"| --- | --- | --- |",
		...[...new Set(builds.map((build) => build.index))].map((index) => {
			const these = builds.filter((build) => build.index === index)
			return `| ${index} | ${ms(median(these.map((build) => build.buildMs)))} | ${(median(these.map((build) => build.bytes)) / 1024).toFixed(0)} KiB |`
		}),
		"",
		"| Secondary indexes | Single-message commit, median ms (p95) |",
		"| --- | --- |",
		...[0, 1, 2].map((indexes) => {
			const times = (run.writes as Record<string, any>[])
				.filter((write) => write.indexes === indexes)
				.flatMap((write) => write.commitMs as number[])
			return `| ${indexes} | ${ms(median(times))} (${ms(quantile(times, 0.95))}) |`
		}),
		"",
	)
}

const syncRuns = files
	.filter((file) => file.startsWith("sync-"))
	.map(read)
	.sort((left, right) =>
		left.dialect === right.dialect
			? left.rows - right.rows || left.clients - right.clients
			: String(left.dialect).localeCompare(right.dialect),
	)
if (syncRuns.length)
	lines.push(
		"### Client sync",
		"",
		"Node in-memory TandemClient replicas, default 150 ms sync interval, connected to the server in process. Every client subscribes to the same view; one client writes. Update latency runs from the author's commit until every other client's subscription shows the message. Work counts SQL statements and rows SQL returned during each phase, for all clients together.",
		"",
		"| DB | Rows | Clients | View | Reads | Initial sync ms | Update ms median (p95), n | Initial statements / rows decoded | Update statements / rows decoded | Exact |",
		"| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
	)
for (const run of syncRuns) {
	const cells = run.cells as Record<string, any>[]
	for (const view of ["paged", "full"])
		for (const reads of ["fullReads", "sql"]) {
			const these = cells.filter(
				(cell) => cell.view === view && cell.reads === reads,
			)
			const updates = these.flatMap((cell) => cell.updateMs as number[])
			const exact = these.every(
				(cell) => cell.initialExact && cell.finalExact && cell.writesStored,
			)
			const work = (phase: "initialWork" | "updateWork", key: string) =>
				median(these.map((cell) => cell[phase][key]))
			syncCsv.push(
				[
					run.dialect,
					run.rows,
					run.clients,
					reads,
					view,
					these.length,
					median(these.map((cell) => cell.initialMs)).toFixed(1),
					median(updates).toFixed(1),
					quantile(updates, 0.95).toFixed(1),
					updates.length,
					work("initialWork", "statements"),
					work("initialWork", "rowsDecoded"),
					work("updateWork", "statements"),
					work("updateWork", "rowsDecoded"),
					exact,
				].join(","),
			)
			lines.push(
				`| ${run.dialect} | ${run.rows.toLocaleString("en-US")} | ${run.clients} | ${view} | ${reads === "sql" ? "SQL" : "whole tables"} | ${ms(median(these.map((cell) => cell.initialMs)))} | ${ms(median(updates))} (${ms(quantile(updates, 0.95))}), ${updates.length} | ${work("initialWork", "statements")} / ${work("initialWork", "rowsDecoded")} | ${work("updateWork", "statements")} / ${work("updateWork", "rowsDecoded")} | ${exact ? "yes" : "NO"} |`,
			)
		}
}

writeFileSync(join(runDir, "summary.md"), `${lines.join("\n")}\n`)
writeFileSync(join(runDir, "queries.csv"), `${queryCsv.join("\n")}\n`)
writeFileSync(join(runDir, "sync.csv"), `${syncCsv.join("\n")}\n`)
console.log(`wrote summary.md, queries.csv, sync.csv in ${runDir}`)
