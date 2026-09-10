import { defineConfig } from "vitest/config"

export default defineConfig({
	esbuild: {
		target: "es2022",
	},
	resolve: {
		alias: {
			"@tanishqkancharla/gatekeeper": new URL(
				"./packages/gatekeeper/src/Gatekeeper.ts",
				import.meta.url,
			).pathname,
			"@tanishqkancharla/tandem-core": new URL(
				"./packages/core/src/index.ts",
				import.meta.url,
			).pathname,
			"@tanishqkancharla/tandem-server": new URL(
				"./packages/server/src/index.ts",
				import.meta.url,
			).pathname,
			"@tanishqkancharla/tandem-react": new URL(
				"./packages/react/src/index.ts",
				import.meta.url,
			).pathname,
		},
	},
	test: {
		allowOnly: !process.env.CI,
		isolate: false,
	},
})
