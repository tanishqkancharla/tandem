import { defineConfig } from "vitest/config"

export default defineConfig({
	resolve: {
		alias: {
			"@get-halo/tandem-core": new URL("./packages/core/src/index.ts", import.meta.url)
				.pathname,
			"@get-halo/tandem-server": new URL(
				"./packages/server/src/index.ts",
				import.meta.url,
			).pathname,
			"@get-halo/tandem-react": new URL("./packages/react/src/index.ts", import.meta.url)
				.pathname,
			"@get-halo/tandem-types": new URL("./packages/types/src/index.ts", import.meta.url)
				.pathname,
		},
	},
	test: {
		allowOnly: !process.env.CI,
		isolate: false,
	},
})
