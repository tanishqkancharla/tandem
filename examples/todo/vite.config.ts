import { fileURLToPath } from "node:url"
import react from "@vitejs/plugin-react"
import { defineConfig } from "vite"

const workspaceRoot = fileURLToPath(new URL("../..", import.meta.url))

export default defineConfig({
	plugins: [react()],
	resolve: {
		alias: {
			"@tanishqkancharla/tandem-core": `${workspaceRoot}/packages/core/src/index.ts`,
			"@tanishqkancharla/tandem-react": `${workspaceRoot}/packages/react/src/index.ts`,
		},
	},
	server: {
		port: 5173,
	},
})
