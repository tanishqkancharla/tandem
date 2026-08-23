import { defineConfig } from "vitest/config"

export default defineConfig({
	test: {
		environment: "jsdom",
		allowOnly: !process.env.CI,
		isolate: false,
	},
})
