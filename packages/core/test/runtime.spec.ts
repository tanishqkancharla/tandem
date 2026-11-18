import { execFile } from "node:child_process"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"
import * as errore from "errore"
import { build } from "esbuild"
import { Miniflare } from "miniflare"
import { expect, test } from "vitest"

const expected = {
	seen: [{ id: "1", text: "hello" }],
	restored: [{ id: "1", text: "hello" }],
}

// Bundles the scenario with core's main entry for a runtime that has no
// Node built-ins, the way a Workers or React Native bundler would.
async function bundle(entry: string) {
	const result = await build({
		stdin: {
			contents: entry,
			resolveDir: join(import.meta.dirname, "runtime"),
			loader: "ts",
		},
		bundle: true,
		write: false,
		format: "esm",
		// Matches the tsc target, so syntax such as `using` is lowered as in dist.
		target: "es2022",
		platform: "neutral",
		mainFields: ["module", "main"],
		conditions: ["workerd", "worker"],
		alias: {
			"@tanishqkancharla/tandem-core": join(
				import.meta.dirname,
				"../src/index.ts",
			),
		},
		logLevel: "silent",
	})
	return result.outputFiles[0]!.text
}

test("core's main entry runs in plain Node without test setup or polyfills", async () => {
	const script = await bundle(
		`import { runScenario } from "./scenario.ts"\nconsole.log(JSON.stringify(await runScenario()))`,
	)
	const dir = await mkdtemp(join(tmpdir(), "tandem-core-runtime-"))
	await using cleanup = new errore.AsyncDisposableStack()
	cleanup.defer(() => rm(dir, { recursive: true, force: true }))
	const file = join(dir, "scenario.mjs")
	await writeFile(file, script)

	// The process must also exit on its own, which fails if the client leaks a timer.
	const { stdout } = await promisify(execFile)(process.execPath, [file], {
		timeout: 10_000,
	})
	// The default logger writes to the console first; the result is the last line.
	expect(JSON.parse(stdout.trim().split("\n").at(-1)!)).toEqual(expected)
})

test("core's main entry runs in workerd without nodejs_compat", async () => {
	const script = await bundle(
		`import { runScenario } from "./scenario.ts"\nexport default { async fetch() { return Response.json(await runScenario()) } }`,
	)
	const runtime = new Miniflare({
		modules: true,
		script,
		compatibilityDate: "2026-07-01",
	})
	await using cleanup = new errore.AsyncDisposableStack()
	cleanup.defer(() => runtime.dispose())

	const response = await runtime.dispatchFetch("http://localhost/")
	expect(await response.json()).toEqual(expected)
})
