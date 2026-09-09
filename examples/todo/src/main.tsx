import {
	IndexedDbTupleStorage,
	TandemClient,
} from "@tanishqkancharla/tandem-core"
import { TandemClientProvider } from "@tanishqkancharla/tandem-react"
import { MauiProvider } from "@tanishqkancharla/maui"
import { StrictMode } from "react"
import { createRoot } from "react-dom/client"
import { App } from "./App"
import { schema } from "./schema"

const db = new TandemClient({
	schema,
	storage: new IndexedDbTupleStorage({
		dbName: "tandem-todo",
		schema,
	}),
})

const ready = db.ready.then(async () => {
	if (db.query({ collection: "todos" }).length > 0) return

	const seedTx = db.transact()
	seedTx.set("todos", {
		id: "welcome",
		text: "Build something with Tandem",
		complete: false,
		createdAt: Date.now(),
	})
	seedTx.set("todos", {
		id: "maui",
		text: "Style it with Maui color tokens",
		complete: true,
		createdAt: Date.now() - 1,
	})
	await db.commit(seedTx)
	await db.flushStorage()
})

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
