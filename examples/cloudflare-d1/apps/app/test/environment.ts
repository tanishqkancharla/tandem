import fs from "node:fs"
import path from "node:path"

/**
 * Where the e2e suite runs. `local` starts three `wrangler dev` processes
 * (workerd). `live` targets deployed Workers; set TANDEM_E2E_MODE=live and the
 * TANDEM_E2E_* URLs and secrets (see README).
 */
export type E2eEnvironment = {
	mode: "local" | "live"
	appUrl: string
	secondAppUrl: string
	coordinatorUrl: string
	appId: string
	secondAppId: string
	appSecret: string
	secondAppSecret: string
	accessKey: string
	/** Optional command that redeploys the coordinator (live restart test). */
	redeployCommand?: string
}

export const localPorts = { app: 8787, secondApp: 8788, coordinator: 8789 }
export const localSecrets = {
	app: "local-app-secret-with-at-least-32-characters",
	secondApp: "local-second-secret-with-at-least-32-characters",
	accessKey: "local-demo-access-key",
}

function required(name: string) {
	const value = process.env[name]
	if (!value) throw new Error(`Set ${name} for TANDEM_E2E_MODE=live`)
	return value
}

export function e2eEnvironment(): E2eEnvironment {
	if (process.env.TANDEM_E2E_MODE === "live") {
		return {
			mode: "live",
			appUrl: required("TANDEM_E2E_APP_URL"),
			secondAppUrl: required("TANDEM_E2E_SECOND_APP_URL"),
			coordinatorUrl: required("TANDEM_E2E_COORDINATOR_URL"),
			appId: process.env.TANDEM_E2E_APP_ID ?? "tandem-demo-app",
			secondAppId:
				process.env.TANDEM_E2E_SECOND_APP_ID ?? "tandem-demo-app-second",
			appSecret: required("TANDEM_E2E_APP_SECRET"),
			secondAppSecret: required("TANDEM_E2E_SECOND_APP_SECRET"),
			accessKey: required("TANDEM_E2E_ACCESS_KEY"),
			redeployCommand: process.env.TANDEM_E2E_REDEPLOY_COMMAND,
		}
	}
	return {
		mode: "local",
		appUrl: `http://127.0.0.1:${localPorts.app}`,
		secondAppUrl: `http://127.0.0.1:${localPorts.secondApp}`,
		coordinatorUrl: `http://127.0.0.1:${localPorts.coordinator}`,
		appId: "tandem-demo-app",
		secondAppId: "tandem-demo-app-second",
		appSecret: localSecrets.app,
		secondAppSecret: localSecrets.secondApp,
		accessKey: localSecrets.accessKey,
	}
}

/** Append one evidence record for RESULT.md (request/message timelines). */
export function recordEvidence(entry: Record<string, unknown>) {
	const directory = path.join(import.meta.dirname, "..", "test-results")
	fs.mkdirSync(directory, { recursive: true })
	const mode = process.env.TANDEM_E2E_MODE === "live" ? "live" : "local"
	fs.appendFileSync(
		path.join(directory, `evidence-${mode}.jsonl`),
		`${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`,
	)
}
