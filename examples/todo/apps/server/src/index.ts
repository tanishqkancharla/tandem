import { serve } from "@hono/node-server"
import type { TodoSchema } from "@tandem/example-todo-shared"
import {
	TandemServerPostgresStorage,
	tandemPostgresTuplesSql,
} from "@tanishqkancharla/tandem-postgres"
import { TandemServerJsonFileStorage } from "@tanishqkancharla/tandem-server"
import * as errore from "errore"
import { fileURLToPath } from "node:url"
import pg from "pg"
import { createTodoApp } from "./app.js"

class TodoServerStartupError extends errore.createTaggedError({
	name: "TodoServerStartupError",
	message: "Todo server failed to $operation",
}) {}

function getPort() {
	const port = Number(process.env.PORT ?? 8787)
	if (Number.isInteger(port) && port > 0) return port
	return new TodoServerStartupError({ operation: "read PORT" })
}

// Postgres when DATABASE_URL is set, otherwise a JSON file.
async function openStorage() {
	const databaseUrl = process.env.DATABASE_URL
	if (!databaseUrl) {
		const filePath =
			process.env.TANDEM_TODO_DATA_FILE ??
			fileURLToPath(new URL("../.data/tandem.json", import.meta.url))
		return new TandemServerJsonFileStorage<TodoSchema>({ filePath })
	}

	const client = new pg.Client({ connectionString: databaseUrl })
	const created = await client
		.connect()
		.then(() => client.query(tandemPostgresTuplesSql))
		.finally(() => client.end())
		.catch(
			(cause) =>
				new TodoServerStartupError({ operation: "create tables", cause }),
		)
	if (created instanceof Error) return created
	return new TandemServerPostgresStorage<TodoSchema>({
		connectionString: databaseUrl,
	})
}

async function start() {
	const port = getPort()
	if (port instanceof Error) return port

	const storage = await openStorage()
	if (storage instanceof Error) return storage
	const service = await createTodoApp({ storage })
	if (service instanceof Error) {
		return new TodoServerStartupError({
			operation: "open TandemServer",
			cause: service,
		})
	}

	const nodeServer = errore.try({
		try: () => serve({ fetch: service.app.fetch, port }),
		catch: (cause) =>
			new TodoServerStartupError({ operation: "listen", cause }),
	})
	if (nodeServer instanceof Error) {
		const closed = await service
			.close()
			.catch(
				(cause) => new TodoServerStartupError({ operation: "close", cause }),
			)
		if (closed instanceof Error) console.error(closed)
		return nodeServer
	}
	const listening = await new Promise<TodoServerStartupError | undefined>(
		(resolve) => {
			const onListening = () => {
				nodeServer.off("error", onError)
				resolve(undefined)
			}
			const onError = (cause: Error) => {
				nodeServer.off("listening", onListening)
				resolve(new TodoServerStartupError({ operation: "listen", cause }))
			}
			nodeServer.once("listening", onListening)
			nodeServer.once("error", onError)
		},
	)
	if (listening instanceof Error) {
		const closed = await service
			.close()
			.catch(
				(cause) => new TodoServerStartupError({ operation: "close", cause }),
			)
		if (closed instanceof Error) console.error(closed)
		return listening
	}
	console.log(`Todo server listening on http://localhost:${port}`)

	const shutdown = () => {
		nodeServer.close((cause) => {
			if (cause)
				console.error(new TodoServerStartupError({ operation: "stop", cause }))
			void service
				.close()
				.catch(
					(cause) => new TodoServerStartupError({ operation: "close", cause }),
				)
				.then((closed) => {
					if (closed instanceof Error) console.error(closed)
				})
		})
		service.endEventStreams()
	}

	process.once("SIGINT", shutdown)
	process.once("SIGTERM", shutdown)
}

const started = await start()
if (started instanceof Error) {
	console.error(started)
	process.exitCode = 1
}
