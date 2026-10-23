import {
	collection,
	defineSchema,
	Logger,
	t,
	TandemClient,
	type RuntimeSchemaDefinition,
} from "@tanishqkancharla/tandem-core"
import sqlite from "node:sqlite"
import { expect, vi } from "vitest"
import { TandemBridgeStorage } from "../src/bridge.js"
import { authorizeTandemConnection } from "../src/createTandemCoordinator.js"
import {
	createTandemClientToken,
	handleTandemBridgeRequest,
	TandemD1Storage,
	tandemD1ClientTableSql,
	type TandemD1Database,
	type TandemD1PreparedStatement,
} from "../src/index.js"
import {
	keepTandemClientConnected,
	TandemCoordinatorRemote,
} from "../src/client/index.js"
import {
	TandemCoordinatorCore,
	type TandemCoordinatorSocket,
	type TandemSocketAttachment,
} from "../src/TandemCoordinatorCore.js"

export type Todo = {
	id: string
	title: string
	done: boolean
	createdAt: number
}

export type TodoSchema = { todos: Todo }

export const todoSchema = defineSchema({
	todos: collection({
		id: t.id(),
		title: t.string(),
		done: t.boolean(),
		createdAt: t.number(),
	}),
}) satisfies RuntimeSchemaDefinition<TodoSchema>

export function todo(id: string, overrides: Partial<Todo> = {}): Todo {
	return { id, title: id, done: false, createdAt: 1, ...overrides }
}

/** A D1-compatible binding over a real in-memory SQLite database. */
export function createSqliteD1() {
	const database = new sqlite.DatabaseSync(":memory:")
	class Statement implements TandemD1PreparedStatement {
		constructor(
			readonly sql: string,
			readonly params: unknown[] = [],
		) {}
		bind(...values: unknown[]) {
			return new Statement(this.sql, values)
		}
		all() {
			const results = database
				.prepare(this.sql)
				.all(...(this.params as sqlite.SQLInputValue[]))
			return Promise.resolve({ results })
		}
	}
	const db: TandemD1Database = {
		prepare: (query) => new Statement(query),
		batch: (statements) => {
			// D1 batches run as one transaction and roll back on any failure.
			database.exec("BEGIN")
			const results = []
			for (const statement of statements as Statement[]) {
				const result = (() => {
					try {
						return database
							.prepare(statement.sql)
							.all(...(statement.params as sqlite.SQLInputValue[]))
					} catch (error) {
						database.exec("ROLLBACK")
						throw error
					}
				})()
				results.push({ results: result })
			}
			database.exec("COMMIT")
			return Promise.resolve(results)
		},
	}
	database.exec(`CREATE TABLE todos (
		id TEXT PRIMARY KEY,
		title TEXT NOT NULL,
		done INTEGER NOT NULL,
		createdAt INTEGER NOT NULL
	)`)
	database.exec(tandemD1ClientTableSql())
	return {
		db,
		/** Plain SQL, as other app code writing the same database would. */
		sql: (query: string, ...params: sqlite.SQLInputValue[]) =>
			database.prepare(query).all(...params),
	}
}

export type Gate = { open: () => void; reached: Promise<void> }

function createGate() {
	const opened = Promise.withResolvers<void>()
	const reached = Promise.withResolvers<void>()
	return {
		open: () => opened.resolve(),
		wait: opened.promise,
		reached: reached.promise,
		markReached: () => reached.resolve(),
	}
}

/** In-process stand-in for the Durable Object runtime's WebSocket handling. */
class CoordinatorHost {
	core!: TandemCoordinatorCore
	readonly sockets = new Map<ServerSocket, TandemSocketAttachment>()
	bridgeRequests: { op: string }[] = []
	private gateNextScan?: ReturnType<typeof createGate>
	private dropNextPushResponse = false

	constructor(
		readonly appId: string,
		readonly secret: string,
		private readonly bridgeFetch: typeof fetch,
	) {
		this.start()
	}

	/** Replace the coordinator's memory, as when a Durable Object wakes or restarts. */
	start() {
		const storage = new TandemBridgeStorage({
			appId: this.appId,
			bridgeUrl: "https://app.example/tandem/bridge",
			secret: this.secret,
			fetch: async (input, init) => {
				const op = (JSON.parse(String(init?.body)) as { op: string }).op
				this.bridgeRequests.push({ op })
				const readsRecords =
					op === "scan" && String(init?.body).includes(`"record"`)
				const gate = readsRecords ? this.gateNextScan : undefined
				const response = await this.bridgeFetch(input, init)
				if (gate) {
					// The scan has read storage; hold its result.
					this.gateNextScan = undefined
					gate.markReached()
					await gate.wait
				}
				return response
			},
		})
		this.core = new TandemCoordinatorCore({
			appId: this.appId,
			storage,
			getSockets: () =>
				[...this.sockets].map(([socket, attachment]) => ({
					socket,
					attachment,
				})),
		})
	}

	/** Restart without hibernation support: every socket closes. */
	restartClosingSockets() {
		for (const socket of this.sockets.keys()) socket.close(1012, "restart")
		this.start()
	}

	/** Hold the next bridge read of records until the returned gate opens. */
	pauseNextScan(): Gate {
		const gate = createGate()
		this.gateNextScan = gate
		return gate
	}

	/** The coordinator applies the next push, but its response never arrives. */
	loseNextPushResponse() {
		this.dropNextPushResponse = true
	}

	shouldDropResponse(request: string) {
		if (!this.dropNextPushResponse || !request.includes(`"type":"push"`))
			return false
		this.dropNextPushResponse = false
		return true
	}

	async accept(url: URL, client: FakeWebSocket) {
		const attachment = await authorizeTandemConnection({
			appId: this.appId,
			url,
			secret: this.secret,
		})
		if (attachment instanceof Response) {
			client.receiveClose(1008, `upgrade rejected: ${attachment.status}`)
			return
		}
		const server = new ServerSocket(client, this, attachment)
		this.sockets.set(server, attachment)
		client.server = server
		await this.core.open(server, attachment)
		client.receiveOpen()
	}
}

class ServerSocket implements TandemCoordinatorSocket {
	closed = false
	constructor(
		private readonly client: FakeWebSocket,
		private readonly host: CoordinatorHost,
		private readonly attachment: TandemSocketAttachment,
	) {}

	send(message: string) {
		if (this.closed) throw new Error("socket closed")
		setTimeout(() => this.client.receiveMessage(message), 0)
	}

	close(code: number, reason: string) {
		if (this.closed) return
		this.closed = true
		this.host.sockets.delete(this)
		this.host.core.close(this.attachment)
		setTimeout(() => this.client.receiveClose(code, reason), 0)
	}

	receive(message: string) {
		if (this.closed) return
		const dropResponse = this.host.shouldDropResponse(message)
		const target = dropResponse
			? {
					send: (response: string) => {
						// Only the push response is lost; later pokes still arrive.
						if (!response.includes(`"type":"response"`)) this.send(response)
					},
					close: this.close.bind(this),
				}
			: this
		void this.host.core.message(target, this.attachment, message)
	}
}

/** Browser WebSocket shape used by TandemCoordinatorRemote, connected in process. */
class FakeWebSocket extends EventTarget {
	static readonly CONNECTING = 0
	static readonly OPEN = 1
	static readonly CLOSING = 2
	static readonly CLOSED = 3
	readonly CONNECTING = 0
	readonly OPEN = 1
	readonly CLOSING = 2
	readonly CLOSED = 3
	readyState = 0
	server?: ServerSocket
	sent: string[] = []

	constructor(
		readonly url: string,
		host: CoordinatorHost,
	) {
		super()
		setTimeout(() => void host.accept(new URL(url), this), 0)
	}

	send(message: string) {
		if (this.readyState !== this.OPEN) throw new Error("socket not open")
		this.sent.push(message)
		const server = this.server
		setTimeout(() => server?.receive(message), 0)
	}

	close(code = 1000, reason = "") {
		if (this.readyState === this.CLOSED) return
		this.server?.close(code, reason)
		this.receiveClose(code, reason)
	}

	receiveOpen() {
		this.readyState = this.OPEN
		this.dispatchEvent(new Event("open"))
	}

	receiveMessage(data: string) {
		if (this.readyState !== this.OPEN) return
		this.dispatchEvent(Object.assign(new Event("message"), { data }))
	}

	receiveClose(code: number, reason: string) {
		if (this.readyState === this.CLOSED) return
		this.readyState = this.CLOSED
		this.dispatchEvent(Object.assign(new Event("close"), { code, reason }))
	}
}

export const secret = "test-secret-with-at-least-32-characters!"

/** One app: its D1 database and bridge, plus a coordinator serving it. */
export function createApp(appId = "todo-app") {
	const database = createSqliteD1()
	const storage = new TandemD1Storage<TodoSchema>({
		db: database.db,
		collections: {
			todos: {
				table: "todos",
				columns: {
					id: "text",
					title: "text",
					done: "boolean",
					createdAt: "integer",
				},
			},
		},
	})
	const bridge = (request: Request) =>
		handleTandemBridgeRequest(request, {
			appId,
			secret,
			storage,
			collections: ["todos"],
		})
	const coordinator = new CoordinatorHost(appId, secret, (input, init) =>
		bridge(new Request(input, init)),
	)
	const sockets: FakeWebSocket[] = []
	const clients: TandemClient<TodoSchema>[] = []
	const stops: (() => void)[] = []

	return {
		appId,
		database,
		storage,
		bridge,
		coordinator,
		sockets,
		/** A browser tab: a Tandem client connected through the coordinator. */
		async connectClient({
			subject = "user-1",
			tokenAppId = appId,
			reconnect = true,
		}: { subject?: string; tokenAppId?: string; reconnect?: boolean } = {}) {
			const remote = new TandemCoordinatorRemote<TodoSchema>({
				url: `wss://coordinator.example/apps/${appId}`,
				getToken: () =>
					createTandemClientToken({ appId: tokenAppId, secret, subject }),
				keepAliveInterval: false,
				requestTimeout: 1000,
				WebSocket: class extends FakeWebSocket {
					constructor(url: string) {
						super(url, coordinator)
						sockets.push(this)
					}
				} as unknown as typeof WebSocket,
			})
			const client = new TandemClient<TodoSchema>({
				schema: todoSchema,
				remote,
				autoConnect: false,
				syncInterval: 0,
				logger: silentLogger,
			})
			clients.push(client)
			await client.ready
			await client.connect()
			if (reconnect) {
				stops.push(
					keepTandemClientConnected(client, remote, { initialDelay: 10 }),
				)
			}
			return { client, remote }
		},
		/** Write through plain SQL, then notify the coordinator, as an app endpoint would. */
		externalWrite(query: string, ...params: sqlite.SQLInputValue[]) {
			database.sql(query, ...params)
			return coordinator.core.invalidate()
		},
		todos: () =>
			database.sql(`SELECT id, title, done FROM todos ORDER BY id`) as {
				id: string
				title: string
				done: number
			}[],
		async [Symbol.asyncDispose]() {
			for (const stop of stops) stop()
			await Promise.all(clients.map((client) => client.disconnect()))
		},
	}
}

const silentLogger = new Logger({ sinks: [] })

export function subscribeTodos(client: TandemClient<TodoSchema>) {
	const subscription = client.subscribe({ collection: "todos" })
	return {
		...subscription,
		current: () => client.query({ collection: "todos" }),
	}
}

export async function eventually(assertion: () => void) {
	await vi.waitFor(assertion, { timeout: 3000, interval: 10 })
}

export { expect }
