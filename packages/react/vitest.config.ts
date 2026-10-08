import { defineConfig } from "vitest/config"

export default defineConfig({
	oxc: {
		target: "es2022",
	},
	test: {
		environment: "jsdom",
		allowOnly: !process.env.CI,
		isolate: false,
	},
})
