import { fileURLToPath } from "node:url"
import react from "@vitejs/plugin-react"
import { defineConfig } from "vite"

const workspaceRoot = fileURLToPath(new URL("../../../..", import.meta.url))
const serverPort = process.env.TANDEM_TODO_SERVER_PORT ?? "8787"

export default defineConfig({
	plugins: [react()],
	resolve: {
		alias: {
			"@tanishqkancharla/tandem-core/internal": `${workspaceRoot}/packages/core/src/internal.ts`,
			"@tanishqkancharla/tandem-core": `${workspaceRoot}/packages/core/src/index.ts`,
			"@tanishqkancharla/tandem-react": `${workspaceRoot}/packages/react/src/index.ts`,
		},
	},
	server: {
		port: Number(process.env.TANDEM_TODO_WEB_PORT ?? 5174),
		strictPort: true,
		proxy: {
			"/api": `http://127.0.0.1:${serverPort}`,
		},
	},
})
