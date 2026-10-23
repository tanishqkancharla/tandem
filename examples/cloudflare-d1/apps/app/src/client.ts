import { TandemClient } from "@tanishqkancharla/tandem-core"
import {
	keepTandemClientConnected,
	TandemCoordinatorRemote,
} from "@tanishqkancharla/tandem-cloudflare/client"
import { todoSchema, type Todo, type TodoSchema } from "./schema.js"

const accessKey = new URLSearchParams(location.hash.slice(1)).get("key") ?? ""
const status = document.querySelector<HTMLElement>("#status")!
const statusText = document.querySelector<HTMLElement>("#status-text")!
const list = document.querySelector<HTMLUListElement>("#todos")!
const form = document.querySelector<HTMLFormElement>("#add")!
const titleInput = document.querySelector<HTMLInputElement>("#title")!

function setStatus(state: "connecting" | "connected" | "error", text: string) {
	status.dataset.state = state
	statusText.textContent = text
}

async function fetchToken() {
	const response = await fetch("/api/token", {
		method: "POST",
		headers: { authorization: `Bearer ${accessKey}` },
	})
	if (!response.ok) throw new Error(`Token request failed: ${response.status}`)
	return (await response.json()) as { token: string; url: string }
}

function render(todos: readonly Todo[]) {
	list.replaceChildren()
	if (!todos.length) {
		const empty = document.createElement("li")
		empty.className = "empty"
		empty.textContent = "Nothing to do yet."
		list.append(empty)
		return
	}
	for (const todo of [...todos].sort((a, b) => a.createdAt - b.createdAt)) {
		const item = document.createElement("li")
		item.dataset.done = String(todo.done)
		const label = document.createElement("label")
		const checkbox = document.createElement("input")
		checkbox.type = "checkbox"
		checkbox.checked = todo.done
		checkbox.addEventListener("change", () => {
			const tx = client.transact()
			tx.update("todos", todo.id, (current) => ({
				...current,
				done: checkbox.checked,
			}))
			void client.commit(tx)
		})
		const text = document.createElement("span")
		text.textContent = todo.title
		label.append(checkbox, text)
		const remove = document.createElement("button")
		remove.type = "button"
		remove.textContent = "Delete"
		remove.setAttribute("aria-label", `Delete ${todo.title}`)
		remove.addEventListener("click", () => {
			const tx = client.transact()
			tx.remove("todos", todo.id)
			void client.commit(tx)
		})
		item.append(label, remove)
		list.append(item)
	}
}

const { url } = await fetchToken().catch((error: unknown) => {
	setStatus("error", "Add #key=<access key> to the URL to connect.")
	throw error
})
const remote = new TandemCoordinatorRemote<TodoSchema>({
	url,
	getToken: async () => (await fetchToken()).token,
})
const client = new TandemClient<TodoSchema>({
	schema: todoSchema,
	remote,
	autoConnect: false,
})
remote.onDisconnect(() => setStatus("connecting", "Reconnecting…"))
keepTandemClientConnected(client, remote, {
	onReconnect: () => setStatus("connected", "Live"),
	onError: () => setStatus("error", "Offline. Retrying…"),
})
await client.ready
const { result } = client.subscribe({ collection: "todos" }, render)
render(result)
await client.connect()
setStatus("connected", "Live")

form.addEventListener("submit", (event) => {
	event.preventDefault()
	const title = titleInput.value.trim()
	if (!title) return
	const tx = client.transact()
	tx.set("todos", {
		id: crypto.randomUUID(),
		title,
		done: false,
		createdAt: Date.now(),
	})
	void client.commit(tx)
	titleInput.value = ""
})
