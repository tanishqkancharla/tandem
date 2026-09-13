import { TandemClient } from "@tanishqkancharla/tandem-core"
import { TandemClientProvider } from "@tanishqkancharla/tandem-react"
import { MauiProvider } from "@tanishqkancharla/maui"
import { schema } from "@tandem/example-todo-shared"
import { StrictMode } from "react"
import { createRoot } from "react-dom/client"
import { App } from "./App"
import { TodoHttpRemote } from "./TodoHttpRemote"

const db = new TandemClient({
	schema,
	remote: new TodoHttpRemote(),
	autoConnect: false,
})

const root = document.getElementById("root")
if (!root) {
	throw new Error("Missing #root")
}

createRoot(root).render(
	<StrictMode>
		<MauiProvider>
			<TandemClientProvider client={db} connect>
				<App />
			</TandemClientProvider>
		</MauiProvider>
	</StrictMode>,
)
