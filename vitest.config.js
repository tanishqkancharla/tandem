import { defineConfig } from "vitest/config"

export default defineConfig({
	resolve: {
		alias: {
			"@tandem/core": new URL("./src/index.ts", import.meta.url).pathname,
			"@tandem/server": new URL(
				"./packages/server/src/index.ts",
				import.meta.url,
			).pathname,
			"@tandem/types": new URL("./src/types.ts", import.meta.url).pathname,
		},
	},
	test: {
		allowOnly: !process.env.CI,
		isolate: false,
	},
})
