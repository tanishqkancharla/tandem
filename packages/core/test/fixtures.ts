import "fake-indexeddb/auto"

import { appendFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { test as base } from "vitest"
import { TandemClient } from "../src/TandemClient"
import { IndexedDbTupleStorage } from "../src/storage/IndexedDbAdapter"
import type { LoggerApi } from "../src/utils/Logger"
import { TestRemote } from "@tandem/testing"
import type { RemoteApi, RngApi } from "@tandem/types"
import type { Task } from "vitest"

export type DemoTodo = {
	id: string
	text: string
	done: boolean
	priority: number
}

export type DemoSchema = {
	todos: DemoTodo
}

export function todo(
	id: string,
	overrides: Partial<DemoTodo> = {},
): DemoTodo {
	return {
		id,
		text: `Todo ${id}`,
		done: false,
		priority: 1,
		...overrides,
	}
}

export const demoTodos = {
	writeSpec: todo("todo-1", { text: "Write the sync spec", priority: 2 }),
	shipDocs: todo("todo-2", {
		text: "Ship the docs",
		done: true,
		priority: 1,
	}),
	fixSync: todo("todo-3", { text: "Fix the sync bug", priority: 3 }),
}

export type DemoRng = {
	next(prefix?: string): string
	create(prefix?: string): RngApi
}

function sanitizePathSegment(value: string): string {
	return value
		.replace(/[^a-zA-Z0-9.-]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.toLowerCase()
}

function getTestLogFilePath(task: Readonly<Task>): string {
	const names: string[] = [task.name]
	let currentSuite = task.suite

	while (currentSuite) {
		names.unshift(currentSuite.name)
		currentSuite = currentSuite.suite
	}

	const fileName = `${names.map(sanitizePathSegment).join("__")}.jsonl`
	return resolve(process.cwd(), "test", "logs", fileName)
}

function serializeLogValue(value: unknown): unknown {
	if (value instanceof Error) {
		return {
			name: value.name,
			message: value.message,
			stack: value.stack,
		}
	}

	try {
		return JSON.parse(JSON.stringify(value))
	} catch {
		return String(value)
	}
}

function createLogger(logFilePath: string, scopeNames: string[] = []): LoggerApi {
	function write(level: "log" | "info" | "warn" | "error", message: string, args: unknown[]) {
		appendFileSync(
			logFilePath,
			`${JSON.stringify({
				ts: new Date().toISOString(),
				level,
				scope: scopeNames,
				message,
				args: args.map(serializeLogValue),
			})}\n`,
		)
	}

	return {
		log: (message, ...args) => {
			write("log", message, args)
		},
		info: (message, ...args) => {
			write("info", message, args)
		},
		warn: (message, ...args) => {
			write("warn", message, args)
		},
		error: (message, ...args) => {
			write("error", message, args)
		},
		scope: (name) => createLogger(logFilePath, [...scopeNames, name]),
	}
}

function createRng(): DemoRng {
	let counter = 0

	return {
		next(prefix = "id") {
			counter += 1
			return `${prefix}-${counter}`
		},
		create(prefix = "id") {
			return {
				randomId: () => {
					counter += 1
					return `${prefix}-${counter}`
				},
			}
		},
	}
}

type ClientOptions = {
	label?: string
	remote?: RemoteApi<DemoSchema> | false
	storageDbName?: string
	syncInterval?: number
	autoConnect?: boolean
}

type Fixtures = {
	logger: LoggerApi
	rng: DemoRng
	server: TestRemote<DemoSchema>
	client1: TandemClient<DemoSchema>
	client2: TandemClient<DemoSchema>
	makeClient: (options?: ClientOptions) => Promise<TandemClient<DemoSchema>>
}

export const test = base.extend<Fixtures>({
	logger: async ({ task, onTestFinished }, use) => {
		const logFilePath = getTestLogFilePath(task)
		mkdirSync(dirname(logFilePath), { recursive: true })
		writeFileSync(logFilePath, "")

		onTestFinished((result) => {
			if (result.state === "fail") {
				const logContents = readFileSync(logFilePath, "utf8")
				console.error(`\n--- Tandem test logs: ${task.name} ---`)
				console.error(`log file: ${logFilePath}`)
				console.error(logContents || "(no logs captured)")
				console.error("--- End Tandem test logs ---\n")
				return
			}

			rmSync(logFilePath, { force: true })
		})

		await use(createLogger(logFilePath))
	},

	rng: async ({}, use) => {
		await use(createRng())
	},

	server: async ({ logger }, use) => {
		await use(new TestRemote<DemoSchema>({ logger }))
	},

	makeClient: async ({ logger, rng, server }, use) => {
		const clients: { client: TandemClient<DemoSchema>; hasRemote: boolean }[] = []
		const storages: { dbName: string; storage: IndexedDbTupleStorage<DemoSchema> }[] = []

		await use(async (options = {}) => {
			const {
				autoConnect = false,
				label = "client",
				remote,
				storageDbName,
				syncInterval = 0,
			} = options

			const resolvedRemote = remote === undefined ? server : remote || undefined
			const storage = storageDbName
				? new IndexedDbTupleStorage<DemoSchema>({ dbName: storageDbName })
				: undefined

			if (storage) {
				storages.push({ dbName: storageDbName, storage })
			}

			const client = new TandemClient<DemoSchema>({
				autoConnect,
				logger,
				rng: rng.create(label),
				remote: resolvedRemote,
				storage,
				syncInterval,
			})

			clients.push({ client, hasRemote: Boolean(resolvedRemote) })
			await client.ready

			return client
		})

		for (const { client, hasRemote } of clients) {
			if (hasRemote) {
				await client.disconnect()
			}
		}

		for (const { storage } of storages) {
			await storage.close()
		}

		for (const dbName of new Set(storages.map(({ dbName }) => dbName))) {
			const storage = new IndexedDbTupleStorage<DemoSchema>({ dbName })
			await storage.clear()
		}
	},

	client1: async ({ makeClient }, use) => {
		await use(await makeClient({ label: "client1", remote: false }))
	},

	client2: async ({ makeClient }, use) => {
		await use(await makeClient({ label: "client2", remote: false }))
	},
})
