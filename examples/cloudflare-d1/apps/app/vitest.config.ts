import { defineConfig } from "vitest/config"

export default defineConfig({
	test: {
		include: ["test/**/*.e2e.ts"],
		globalSetup: ["test/globalSetup.ts"],
		testTimeout: 240_000,
		hookTimeout: 120_000,
		fileParallelism: false,
		allowOnly: !process.env.CI,
	},
})
