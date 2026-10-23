#!/usr/bin/env node
// Provision and deploy the demo: two app Workers (each with its own D1 database)
// and one coordinator Worker with a SQLite-backed Durable Object namespace.
// Requires Wrangler auth: `wrangler login`, or CLOUDFLARE_API_TOKEN plus
// CLOUDFLARE_ACCOUNT_ID. Re-running reuses databases and secrets.
import { execFileSync } from "node:child_process"
import crypto from "node:crypto"
import fs from "node:fs"
import path from "node:path"

const root = path.join(import.meta.dirname, "..")
const appDir = path.join(root, "apps", "app")
const coordinatorDir = path.join(root, "apps", "coordinator")
const stateDir = path.join(root, ".deploy")
const statePath = path.join(stateDir, "state.json")
const wrangler = path.join(appDir, "node_modules", ".bin", "wrangler")
const prefix = process.env.TANDEM_DEMO_PREFIX ?? "tandem-demo"

fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 })
const state = fs.existsSync(statePath)
	? JSON.parse(fs.readFileSync(statePath, "utf8"))
	: {}
const save = () =>
	fs.writeFileSync(statePath, JSON.stringify(state, null, "\t"), {
		mode: 0o600,
	})

function run(args, { cwd = appDir, input, capture = true } = {}) {
	console.error(`$ wrangler ${args.join(" ")}`)
	return execFileSync(wrangler, args, {
		cwd,
		input,
		encoding: "utf8",
		stdio: [
			input === undefined ? "inherit" : "pipe",
			capture ? "pipe" : "inherit",
			"inherit",
		],
		env: { ...process.env, WRANGLER_SEND_METRICS: "false" },
	})
}

/** Run `wrangler deploy` and return the workers.dev URL it published. */
function deploy(cwd, args) {
	const output = path.join(stateDir, `deploy-${Date.now()}.ndjson`)
	execFileSync(wrangler, ["deploy", ...args], {
		cwd,
		stdio: "inherit",
		env: {
			...process.env,
			WRANGLER_OUTPUT_FILE_PATH: output,
			WRANGLER_SEND_METRICS: "false",
		},
	})
	const entries = fs
		.readFileSync(output, "utf8")
		.trim()
		.split("\n")
		.map((line) => JSON.parse(line))
	fs.rmSync(output)
	const deployed = entries.find((entry) => entry.type === "deploy")
	const url = deployed?.targets?.find((target) =>
		target.endsWith(".workers.dev"),
	)
	if (!url) throw new Error("wrangler deploy did not report a workers.dev URL")
	return {
		url: url.startsWith("http") ? url : `https://${url}`,
		versionId: deployed.version_id,
	}
}

function putSecrets(cwd, workerName, secrets) {
	const file = path.join(stateDir, `secrets-${workerName}.json`)
	fs.writeFileSync(file, JSON.stringify(secrets), { mode: 0o600 })
	try {
		run(["secret", "bulk", file, "--name", workerName], { cwd, capture: false })
	} finally {
		fs.rmSync(file, { force: true })
	}
}

function ensureDatabase(name) {
	const list = () => JSON.parse(run(["d1", "list", "--json"]))
	let database = list().find((entry) => entry.name === name)
	if (!database) {
		run(["d1", "create", name], { capture: false })
		database = list().find((entry) => entry.name === name)
	}
	return database.uuid
}

const secret = () => crypto.randomBytes(32).toString("base64url")

run(["whoami"], { capture: false })

const apps = [
	{ key: "first", worker: `${prefix}-app`, appId: `${prefix}-app`, env: [] },
	{
		key: "second",
		worker: `${prefix}-app-second`,
		appId: `${prefix}-app-second`,
		env: ["--env", "second"],
	},
]
state.accessKey ??= secret()
for (const app of apps) {
	state[app.key] ??= {}
	state[app.key].secret ??= secret()
	state[app.key].databaseId = ensureDatabase(app.worker)
}
save()

// Generated configs carry account-specific IDs and stay out of Git.
const appConfig = JSON.parse(
	fs
		.readFileSync(path.join(appDir, "wrangler.jsonc"), "utf8")
		.replace(/^\s*\/\/.*$/gm, ""),
)
appConfig.$schema = undefined
appConfig.name = apps[0].worker
appConfig.d1_databases[0].database_id = state.first.databaseId
appConfig.d1_databases[0].database_name = apps[0].worker
appConfig.env.second.name = apps[1].worker
appConfig.env.second.d1_databases[0].database_id = state.second.databaseId
appConfig.env.second.d1_databases[0].database_name = apps[1].worker
const generatedAppConfig = path.join(appDir, "wrangler.deploy.json")
const coordinatorWorker = `${prefix}-coordinator`
const coordinatorConfig = JSON.parse(
	fs
		.readFileSync(path.join(coordinatorDir, "wrangler.jsonc"), "utf8")
		.replace(/^\s*\/\/.*$/gm, ""),
)
coordinatorConfig.$schema = undefined
coordinatorConfig.name = coordinatorWorker
const generatedCoordinatorConfig = path.join(
	coordinatorDir,
	"wrangler.deploy.json",
)
fs.writeFileSync(
	generatedCoordinatorConfig,
	JSON.stringify(coordinatorConfig, null, "\t"),
)

// Coordinator first: its URL is configuration for the apps.
const coordinator = deploy(coordinatorDir, [
	"--config",
	generatedCoordinatorConfig,
])
state.coordinator = {
	worker: coordinatorWorker,
	url: coordinator.url,
	versionId: coordinator.versionId,
}
save()

execFileSync("pnpm", ["run", "build:client"], { cwd: appDir, stdio: "inherit" })
for (const app of apps) {
	const vars = { APP_ID: app.appId, COORDINATOR_URL: coordinator.url }
	if (app.key === "first") appConfig.vars = vars
	else appConfig.env.second.vars = vars
}
fs.writeFileSync(generatedAppConfig, JSON.stringify(appConfig, null, "\t"))
for (const app of apps) {
	run(
		[
			"d1",
			"migrations",
			"apply",
			"DB",
			"--remote",
			"--config",
			generatedAppConfig,
			...app.env,
		],
		{
			capture: false,
			input: "y\n",
		},
	)
	const deployed = deploy(appDir, ["--config", generatedAppConfig, ...app.env])
	putSecrets(appDir, app.worker, {
		TANDEM_SECRET: state[app.key].secret,
		DEMO_ACCESS_KEY: state.accessKey,
	})
	Object.assign(state[app.key], {
		worker: app.worker,
		appId: app.appId,
		url: deployed.url,
	})
	save()
}

putSecrets(coordinatorDir, coordinatorWorker, {
	TANDEM_APPS: JSON.stringify(
		Object.fromEntries(
			apps.map((app) => [
				app.appId,
				{
					bridgeUrl: `${state[app.key].url}/tandem/bridge`,
					secret: state[app.key].secret,
				},
			]),
		),
	),
})
state.deployedAt = new Date().toISOString()
save()

console.log(`
Deployed (state with secrets: ${path.relative(process.cwd(), statePath)}):
  coordinator: ${state.coordinator.url}
  app:         ${state.first.url}   (D1 ${state.first.databaseId})
  second app:  ${state.second.url}   (D1 ${state.second.databaseId})
  demo UI:     ${state.first.url}/#key=<accessKey from state.json>
Run the live suite: node scripts/live-test.mjs
`)
