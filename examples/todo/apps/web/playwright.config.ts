import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { defineConfig, devices } from "@playwright/test"

const webDirectory = fileURLToPath(new URL(".", import.meta.url))
const serverDirectory = fileURLToPath(new URL("../server", import.meta.url))
const dataFile = path.join(os.tmpdir(), `tandem-todo-e2e-${process.pid}.json`)

export default defineConfig({
	testDir: "./e2e",
	fullyParallel: false,
	workers: 1,
	use: {
		baseURL: "http://127.0.0.1:5174",
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
			env: { TANDEM_TODO_DATA_FILE: dataFile },
			url: "http://127.0.0.1:8787/health",
			reuseExistingServer: false,
			timeout: 120_000,
		},
		{
			command: "node_modules/.bin/vite --host 127.0.0.1",
			cwd: webDirectory,
			url: "http://127.0.0.1:5174",
			reuseExistingServer: false,
			timeout: 120_000,
		},
	],
})
