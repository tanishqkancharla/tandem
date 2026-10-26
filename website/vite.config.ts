import { tanstackStart } from "@tanstack/react-start/plugin/vite"
import react from "@vitejs/plugin-react"
import { defineConfig } from "vite"

export default defineConfig({
	plugins: [tanstackStart({ spa: { enabled: true } }), react()],
	// Maui publishes extensionless imports and CSS; bundle it for the shell build.
	ssr: {
		noExternal: ["maui", "lodash"],
		optimizeDeps: { include: ["maui > lodash"] },
	},
	server: {
		allowedHosts: [".onamp.dev"],
	},
})
