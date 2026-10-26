import { holocron } from "@holocron.so/vite"
import { defineConfig } from "vite"

export default defineConfig({
	plugins: [holocron()],
	server: { allowedHosts: [".onamp.dev"] },
})
