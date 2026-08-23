import { TandemClientProvider } from "@tandem/react"
import { MauiProvider } from "@tanishqkancharla/maui"
import { StrictMode } from "react"
import { createRoot } from "react-dom/client"
import { App } from "./App"
import { db, ready } from "./db"

const root = document.getElementById("root")
if (!root) {
	throw new Error("Missing #root")
}

createRoot(root).render(
	<StrictMode>
		<MauiProvider>
			<TandemClientProvider client={db} ready={ready}>
				<App />
			</TandemClientProvider>
		</MauiProvider>
	</StrictMode>,
)
