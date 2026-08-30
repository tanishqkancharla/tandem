import { fileURLToPath } from "node:url"
import react from "@vitejs/plugin-react"
import { defineConfig } from "vite"

const workspaceRoot = fileURLToPath(new URL("../..", import.meta.url))

export default defineConfig({
	plugins: [react()],
	resolve: {
		alias: {
			"@get-halo/tandem-core": `${workspaceRoot}/packages/core/src/index.ts`,
			"@get-halo/tandem-react": `${workspaceRoot}/packages/react/src/index.ts`,
			"@get-halo/tandem-types": `${workspaceRoot}/packages/types/src/index.ts`,
		},
	},
	server: {
		port: 5173,
	},
})
