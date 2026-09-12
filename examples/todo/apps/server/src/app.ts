import type { TodoRemoteRequest, TodoSchema } from "@tandem/example-todo-shared"
import type { RemoteApi } from "@tanishqkancharla/tandem-core"
import * as errore from "errore"
import { Hono } from "hono"
import { createTodoSyncServer } from "./TodoSyncServer"

class TodoHonoError extends errore.createTaggedError({
	name: "TodoHonoError",
	message: "Todo HTTP server failed to $operation",
}) {}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isTodoRemoteRequest(value: unknown): value is TodoRemoteRequest {
	return (
		isRecord(value) &&
		(value.action === "pull" || value.action === "push") &&
		isRecord(value.args)
	)
}

function validateRequest(value: unknown) {
	if (isTodoRemoteRequest(value)) return value
	return new TodoHonoError({ operation: "validate request" })
}

type TodoRemote = Pick<RemoteApi<TodoSchema>, "pull" | "push">

function executeRequest({
	remote,
	request,
}: {
	remote: TodoRemote
	request: TodoRemoteRequest
}) {
	if (request.action === "push") {
		return remote
			.push(request.args)
			.then(() => ({}))
			.catch(
				(cause) => new TodoHonoError({ operation: "push mutation", cause }),
			)
	}

	return remote
		.pull(request.args)
		.catch((cause) => new TodoHonoError({ operation: "pull changes", cause }))
}

export async function createTodoApp({ filePath }: { filePath: string }) {
	const remote = await createTodoSyncServer({ filePath })
	if (remote instanceof Error) return remote

	const app = new Hono()
	app.get("/health", (context) => context.json({ status: "ok" }))
	app.post("/api/tandem", async (context) => {
		const json = await context.req
			.json<unknown>()
			.catch(
				(cause) => new TodoHonoError({ operation: "parse request", cause }),
			)
		if (json instanceof Error) {
			return context.json({ error: "Invalid Tandem request" }, 400)
		}

		const request = validateRequest(json)
		if (request instanceof Error) {
			return context.json({ error: "Invalid Tandem request" }, 400)
		}

		const result = await executeRequest({ remote, request })
		if (result instanceof Error) {
			console.error(result)
			return context.json({ error: "Tandem request failed" }, 500)
		}

		return context.json(result)
	})

	return {
		app,
		close: () => remote.close(),
	}
}
