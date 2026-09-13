import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { defineConfig, devices } from "@playwright/test"

const webDirectory = fileURLToPath(new URL(".", import.meta.url))
const serverDirectory = fileURLToPath(new URL("../server", import.meta.url))
const dataFile = path.join(os.tmpdir(), `tandem-todo-e2e-${process.pid}.json`)
const serverPort = process.env.TANDEM_TODO_SERVER_PORT ?? "8787"
const webPort = process.env.TANDEM_TODO_WEB_PORT ?? "5174"
const baseURL = `http://127.0.0.1:${webPort}`

export default defineConfig({
	testDir: "./e2e",
	fullyParallel: false,
	workers: 1,
	use: {
		baseURL,
		trace: "retain-on-failure",
	},
	projects: [
		{
			name: "chromium",
			use: { ...devices["Desktop Chrome"] },
		},
	],
	webServer: [
		{
			command: "node_modules/.bin/tsx src/index.ts",
			cwd: serverDirectory,
			env: { PORT: serverPort, TANDEM_TODO_DATA_FILE: dataFile },
			url: `http://127.0.0.1:${serverPort}/health`,
			reuseExistingServer: false,
			timeout: 120_000,
		},
		{
			command: `node_modules/.bin/vite --host 127.0.0.1 --port ${webPort}`,
			cwd: webDirectory,
			env: { TANDEM_TODO_SERVER_PORT: serverPort },
			url: baseURL,
			reuseExistingServer: false,
			timeout: 120_000,
		},
	],
})
