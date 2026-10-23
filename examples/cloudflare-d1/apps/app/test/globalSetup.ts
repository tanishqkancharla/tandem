import { spawn, spawnSync, type ChildProcess } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { localPorts, localSecrets } from "./environment.js"

const appDirectory = path.join(import.meta.dirname, "..")
const coordinatorDirectory = path.join(appDirectory, "..", "coordinator")
const wrangler = path.join(appDirectory, "node_modules", ".bin", "wrangler")

async function waitFor(url: string, child: ChildProcess, log: string) {
	for (let attempt = 0; attempt < 120; attempt++) {
		if (child.exitCode !== null) {
			throw new Error(`wrangler exited early:\n${fs.readFileSync(log, "utf8")}`)
		}
		const ready = await fetch(url).then(
			() => true,
			() => false,
		)
		if (ready) return
		await new Promise((resolve) => setTimeout(resolve, 500))
	}
	throw new Error(
		`Timed out waiting for ${url}:\n${fs.readFileSync(log, "utf8")}`,
	)
}

/** Start the app, a second app, and the coordinator under local workerd. */
export default async function setup() {
	if (process.env.TANDEM_E2E_MODE === "live") return
	const state = fs.mkdtempSync(path.join(os.tmpdir(), "tandem-cf-e2e-"))
	const children: ChildProcess[] = []
	const start = (
		name: string,
		cwd: string,
		args: string[],
		healthUrl: string,
	) => {
		const log = path.join(state, `${name}.log`)
		const output = fs.openSync(log, "w")
		const child = spawn(wrangler, ["dev", ...args], {
			cwd,
			stdio: ["ignore", output, output],
			env: { ...process.env, WRANGLER_SEND_METRICS: "false" },
		})
		children.push(child)
		return waitFor(healthUrl, child, log)
	}

	// Separate persistence per Worker: concurrent workerd processes lock shared SQLite files.
	const persistence = {
		app: path.join(state, "app"),
		secondApp: path.join(state, "second-app"),
		coordinator: path.join(state, "coordinator"),
	}
	for (const [environment, persistTo] of [
		[[], persistence.app],
		[["--env", "second"], persistence.secondApp],
	] as const) {
		const migrated = spawnSync(
			wrangler,
			[
				"d1",
				"migrations",
				"apply",
				"DB",
				"--local",
				"--persist-to",
				persistTo,
				...environment,
			],
			{ cwd: appDirectory, encoding: "utf8" },
		)
		if (migrated.status !== 0)
			throw new Error(migrated.stderr || migrated.stdout)
	}

	const coordinatorUrl = `http://127.0.0.1:${localPorts.coordinator}`
	const apps = {
		"tandem-demo-app": {
			bridgeUrl: `http://127.0.0.1:${localPorts.app}/tandem/bridge`,
			secret: localSecrets.app,
		},
		"tandem-demo-app-second": {
			bridgeUrl: `http://127.0.0.1:${localPorts.secondApp}/tandem/bridge`,
			secret: localSecrets.secondApp,
		},
	}
	const appArgs = (port: number, secret: string, persistTo: string) => [
		"--port",
		String(port),
		"--inspector-port",
		String(port + 1000),
		"--persist-to",
		persistTo,
		"--var",
		`TANDEM_SECRET:${secret}`,
		"--var",
		`DEMO_ACCESS_KEY:${localSecrets.accessKey}`,
		"--var",
		`COORDINATOR_URL:${coordinatorUrl}`,
	]
	const stop = () => {
		for (const child of children) child.kill("SIGTERM")
		fs.rmSync(state, { recursive: true, force: true })
	}
	const started = Promise.all([
		start(
			"app",
			appDirectory,
			appArgs(localPorts.app, localSecrets.app, persistence.app),
			`http://127.0.0.1:${localPorts.app}/`,
		),
		start(
			"second-app",
			appDirectory,
			[
				"--env",
				"second",
				...appArgs(
					localPorts.secondApp,
					localSecrets.secondApp,
					persistence.secondApp,
				),
			],
			`http://127.0.0.1:${localPorts.secondApp}/`,
		),
		start(
			"coordinator",
			coordinatorDirectory,
			[
				"--port",
				String(localPorts.coordinator),
				"--inspector-port",
				String(localPorts.coordinator + 1000),
				"--persist-to",
				persistence.coordinator,
				"--var",
				`TANDEM_APPS:${JSON.stringify(apps)}`,
				"--var",
				"TANDEM_ALLOW_INSECURE_BRIDGE:true",
			],
			`${coordinatorUrl}/health`,
		),
	])

	const ready = await started.then(
		() => undefined,
		(error: unknown) => error,
	)
	if (ready !== undefined) {
		stop()
		throw ready
	}
	return stop
}
