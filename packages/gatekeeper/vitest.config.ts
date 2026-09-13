import { defineConfig } from "vitest/config"

export default defineConfig({
	resolve: {
		alias: {
			"@tanishqkancharla/gatekeeper": new URL(
				"./src/Gatekeeper.ts",
				import.meta.url,
			).pathname,
		},
	},
	test: {
		include: ["test/**/*.spec.ts"],
		allowOnly: !process.env.CI,
	},
})
