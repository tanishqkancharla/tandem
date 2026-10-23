#!/usr/bin/env node
// Run the e2e suite against the deployed Workers recorded by deploy.mjs.
// Pass --redeploy to include the coordinator redeploy/restart test.
import { execFileSync } from "node:child_process"
import fs from "node:fs"
import path from "node:path"

const root = path.join(import.meta.dirname, "..")
const state = JSON.parse(
	fs.readFileSync(path.join(root, ".deploy", "state.json"), "utf8"),
)
const appDir = path.join(root, "apps", "app")
const coordinatorDir = path.join(root, "apps", "coordinator")
const redeploy = process.argv.includes("--redeploy")
	? `${path.join(appDir, "node_modules", ".bin", "wrangler")} deploy --config ${path.join(coordinatorDir, "wrangler.deploy.json")}`
	: undefined

execFileSync(
	"pnpm",
	[
		"exec",
		"vitest",
		"run",
		"--config",
		"vitest.config.ts",
		...process.argv.slice(2).filter((arg) => arg !== "--redeploy"),
	],
	{
		cwd: appDir,
		stdio: "inherit",
		env: {
			...process.env,
			TANDEM_E2E_MODE: "live",
			TANDEM_E2E_APP_URL: state.first.url,
			TANDEM_E2E_SECOND_APP_URL: state.second.url,
			TANDEM_E2E_COORDINATOR_URL: state.coordinator.url,
			TANDEM_E2E_APP_ID: state.first.appId,
			TANDEM_E2E_SECOND_APP_ID: state.second.appId,
			TANDEM_E2E_APP_SECRET: state.first.secret,
			TANDEM_E2E_SECOND_APP_SECRET: state.second.secret,
			TANDEM_E2E_ACCESS_KEY: state.accessKey,
			...(redeploy ? { TANDEM_E2E_REDEPLOY_COMMAND: redeploy } : {}),
		},
	},
)
