import { defineConfig } from "@playwright/test"

export default defineConfig({
	testDir: "./e2e",
	use: {
		baseURL: "http://127.0.0.1:3001",
		trace: "retain-on-failure",
	},
	webServer: {
		command: "pnpm exec vite --host 127.0.0.1 --port 3001 --strictPort",
		url: "http://127.0.0.1:3001",
		reuseExistingServer: false,
	},
})
