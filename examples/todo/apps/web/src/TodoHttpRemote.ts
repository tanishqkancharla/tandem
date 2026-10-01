import type {
	TodoPullResult,
	TodoPushResult,
	TodoRemoteRequest,
	TodoSchema,
} from "@tandem/example-todo-shared"
import type {
	RemoteApi,
	RemoteRequestError,
} from "@tanishqkancharla/tandem-core"
import * as errore from "errore"

class TodoHttpRemoteError extends errore.createTaggedError({
	name: "TodoHttpRemoteError",
	message: "Todo remote $operation request failed",
}) {}

async function request<Result>({
	operation,
	body,
}: {
	operation: "pull" | "push"
	body: TodoRemoteRequest
}): Promise<Result | RemoteRequestError> {
	const serialized = errore.try({
		try: () => JSON.stringify(body),
		catch: (cause) => new TodoHttpRemoteError({ operation, cause }),
	})
	if (serialized instanceof Error)
		return { error: "invalid-request", message: serialized.message }

	const response = await fetch("/api/tandem", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: serialized,
	}).catch((cause) => new TodoHttpRemoteError({ operation, cause }))
	if (response instanceof Error)
		return { error: "unavailable", message: response.message }
	if (!response.ok) {
		return {
			error: response.status === 400 ? "invalid-request" : "unavailable",
			message: `HTTP ${response.status}`,
		}
	}

	const parsed = await response
		.json()
		.then((value: unknown) => ({ value }))
		.catch((cause) => new TodoHttpRemoteError({ operation, cause }))
	if (parsed instanceof Error)
		return { error: "unavailable", message: parsed.message }

	// This is the typed JSON boundary after the server validates the envelope.
	return parsed.value as Result
}

export class TodoHttpRemote implements RemoteApi<TodoSchema> {
	private pollTimer: ReturnType<typeof setInterval> | undefined
	private poke: (() => void) | undefined

	connect: RemoteApi<TodoSchema>["connect"] = ({ poke }) => {
		this.poke = poke
		this.pollTimer = setInterval(poke, 1_000)

		return Promise.resolve(() => {
			if (this.pollTimer) clearInterval(this.pollTimer)
			this.pollTimer = undefined
			this.poke = undefined
			return Promise.resolve()
		})
	}

	push: RemoteApi<TodoSchema>["push"] = async (args) => {
		const result = await request<TodoPushResult>({
			operation: "push",
			body: { action: "push", args },
		})
		if ("error" in result) return result

		// Pull immediately to acknowledge this client's mutation.
		this.poke?.()
		return result
	}

	pull: RemoteApi<TodoSchema>["pull"] = async (args) => {
		const result = await request<TodoPullResult>({
			operation: "pull",
			body: { action: "pull", args },
		})
		return result
	}
}
