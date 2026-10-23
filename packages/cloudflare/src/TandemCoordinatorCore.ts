import type {
	AnyRelations,
	AnySchema,
	ClientId,
	Cookie,
	RemoteRequestError,
	RuntimeSchemaDefinition,
	ScanWindow,
} from "@tanishqkancharla/tandem-core"
import { TandemServer } from "@tanishqkancharla/tandem-server"
import * as errore from "errore"
import type { TandemBridgeStorage } from "./bridge.js"
import {
	tandemCloseCodes,
	type TandemCoordinatorMessage,
	type TandemCoordinatorRequest,
	type TandemCoordinatorResponse,
	type TandemCoordinatorStats,
} from "./protocol.js"

/** Verified identity the coordinator stores with each socket. Written only by the server. */
export type TandemSocketAttachment = {
	/** Random per socket. Socket objects may be recreated after hibernation. */
	connectionId: string
	appId: string
	subject: string
	/** Browser client ID namespaced by subject. */
	clientId: string
	expiresAt: number
}

export type TandemCoordinatorSocket = {
	send(message: string): void
	close(code: number, reason: string): void
}

export type TandemCoordinatorLimits = {
	maxMessageBytes: number
	maxMutationsPerPush: number
	maxOpsPerPush: number
	maxQueriesPerPull: number
}

export const defaultTandemCoordinatorLimits: TandemCoordinatorLimits = {
	maxMessageBytes: 1024 * 1024,
	maxMutationsPerPush: 500,
	maxOpsPerPush: 5000,
	maxQueriesPerPull: 64,
}

class TandemCoordinatorError extends errore.createTaggedError({
	name: "TandemCoordinatorError",
	message: "Tandem coordinator $operation failed",
}) {}

type CoordinatorServer = {
	server: TandemServer<AnySchema, AnyRelations<AnySchema>>
	collections: ReadonlySet<string>
}

export type TandemCoordinatorCoreArgs = {
	appId: string
	storage: TandemBridgeStorage
	/** Live sockets. Durable Objects return hibernated sockets here after waking. */
	getSockets: () => Iterable<{
		socket: TandemCoordinatorSocket
		attachment: TandemSocketAttachment
	}>
	limits?: Partial<TandemCoordinatorLimits>
	now?: () => number
	instanceId?: string
}

function isRecordObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value)
}

/**
 * Runtime-independent coordinator: one TandemServer over the app's bridge,
 * plus WebSocket message handling and poke fan-out. Holds no records; its
 * per-client views are disposable and reset clients when lost.
 */
export class TandemCoordinatorCore {
	private readonly limits: TandemCoordinatorLimits
	private readonly now: () => number
	private readonly connections = new Map<
		string,
		{ socket: TandemCoordinatorSocket; disconnect: () => Promise<void> }
	>()
	private initialization?: Promise<CoordinatorServer | Error>
	private readonly statistics: TandemCoordinatorStats

	constructor(private readonly args: TandemCoordinatorCoreArgs) {
		this.limits = { ...defaultTandemCoordinatorLimits, ...args.limits }
		this.now = args.now ?? Date.now
		this.statistics = {
			instanceId: args.instanceId ?? crypto.randomUUID(),
			constructedAt: this.now(),
			sockets: 0,
			pokes: 0,
			bridgeRequests: 0,
		}
	}

	get appId() {
		return this.args.appId
	}

	/** Register a newly accepted socket so it receives pokes. */
	async open(
		socket: TandemCoordinatorSocket,
		attachment: TandemSocketAttachment,
	): Promise<void> {
		const initialized = await this.initialize()
		if (initialized instanceof Error) {
			console.error(initialized)
			socket.close(1011, "coordinator unavailable")
			return
		}
		this.connect(initialized, socket, attachment)
	}

	async message(
		socket: TandemCoordinatorSocket,
		attachment: TandemSocketAttachment,
		data: string | ArrayBuffer,
	): Promise<void> {
		if (attachment.appId !== this.appId) {
			socket.close(1011, "app mismatch")
			return
		}
		if (attachment.expiresAt <= this.now()) {
			socket.close(tandemCloseCodes.tokenExpired, "token expired")
			return
		}
		if (typeof data !== "string") {
			socket.close(tandemCloseCodes.invalidMessage, "expected a text message")
			return
		}
		if (data.length > this.limits.maxMessageBytes) {
			socket.close(tandemCloseCodes.invalidMessage, "message too large")
			return
		}
		const request = errore.try(
			() => JSON.parse(data) as TandemCoordinatorRequest,
		)
		if (
			request instanceof Error ||
			!isRecordObject(request) ||
			!Number.isSafeInteger(request.requestId)
		) {
			socket.close(tandemCloseCodes.invalidMessage, "invalid message")
			return
		}

		const initialized = await this.initialize()
		if (!(initialized instanceof Error)) {
			this.connect(initialized, socket, attachment)
		}
		const response: TandemCoordinatorResponse =
			initialized instanceof Error
				? { error: "unavailable", message: "coordinator unavailable" }
				: await this.handle(initialized, socket, attachment, request)
		if (initialized instanceof Error) console.error(initialized)
		this.send(socket, {
			type: "response",
			requestId: request.requestId,
			response,
		})
	}

	close(attachment: TandemSocketAttachment) {
		const connection = this.connections.get(attachment.connectionId)
		this.connections.delete(attachment.connectionId)
		this.statistics.sockets = this.connections.size
		void connection?.disconnect()
	}

	/** Count a coordinator-to-app bridge round trip. */
	recordBridgeRequest() {
		this.statistics.bridgeRequests++
	}

	/** The app committed external writes. Ask every connected client to pull. */
	async invalidate(): Promise<number | Error> {
		const initialized = await this.initialize()
		if (initialized instanceof Error) return initialized
		this.args.storage.notifyChanged()
		return this.connections.size
	}

	stats(): TandemCoordinatorStats {
		return { ...this.statistics }
	}

	private initialize() {
		this.initialization ??= this.createServer().then((result) => {
			// Retry a failed bridge description on the next request.
			if (result instanceof Error) this.initialization = undefined
			return result
		})
		return this.initialization
	}

	private async createServer(): Promise<CoordinatorServer | Error> {
		const description = await this.args.storage.describe()
		if (description instanceof Error) {
			return new TandemCoordinatorError({
				operation: "initialize",
				cause: description,
			})
		}
		const server = new TandemServer<AnySchema, AnyRelations<AnySchema>>({
			// TandemServer only uses the schema for typing; collections arrive from the bridge.
			schema: { collections: {} } as RuntimeSchemaDefinition<AnySchema>,
			relations: description.relations,
			storage: this.args.storage,
		})
		const created = {
			server,
			collections: new Set(description.collections),
		}
		// Hibernated sockets wake with the object; reconnect them for pokes.
		for (const { socket, attachment } of this.args.getSockets()) {
			if (attachment.appId === this.appId)
				this.connect(created, socket, attachment)
		}
		return created
	}

	private connect(
		{ server }: CoordinatorServer,
		socket: TandemCoordinatorSocket,
		attachment: TandemSocketAttachment,
	) {
		const existing = this.connections.get(attachment.connectionId)
		if (existing) {
			existing.socket = socket
			return
		}
		const connected = server.connect({
			clientId: attachment.clientId as ClientId,
			poke: () => {
				const connection = this.connections.get(attachment.connectionId)
				if (!connection) return Promise.resolve()
				this.statistics.pokes++
				this.send(connection.socket, { type: "poke" })
				return Promise.resolve()
			},
		})
		this.connections.set(attachment.connectionId, {
			socket,
			disconnect: async () => {
				const unsubscribe = await connected
				if (typeof unsubscribe === "function") await unsubscribe()
			},
		})
		this.statistics.sockets = this.connections.size
	}

	private send(
		socket: TandemCoordinatorSocket,
		message: TandemCoordinatorMessage,
	) {
		const sent = errore.try(() => socket.send(JSON.stringify(message)))
		if (sent instanceof Error) {
			console.warn("Tandem coordinator could not send to a closed socket", sent)
		}
	}

	private async handle(
		{ server, collections }: CoordinatorServer,
		socket: TandemCoordinatorSocket,
		attachment: TandemSocketAttachment,
		request: TandemCoordinatorRequest,
	): Promise<TandemCoordinatorResponse> {
		const clientId = attachment.clientId as ClientId
		switch (request.type) {
			case "pull": {
				const invalid = this.validatePull(request)
				if (invalid) return { error: "invalid-request", message: invalid }
				const response = await server
					.pull({
						clientId,
						cookie: request.cookie,
						scanWindow: request.scanWindow,
					})
					.catch(
						(cause) => new TandemCoordinatorError({ operation: "pull", cause }),
					)
				return this.toResponse(response)
			}
			case "push": {
				const invalid = this.validatePush(request, collections)
				if (invalid) return { error: "invalid-request", message: invalid }
				const response = await server
					.push({ clientId, mutations: request.mutations })
					.catch(
						(cause) => new TandemCoordinatorError({ operation: "push", cause }),
					)
				return this.toResponse(response)
			}
			case "stats":
				return this.stats()
			default:
				socket.close(tandemCloseCodes.invalidMessage, "unknown request type")
				return { error: "invalid-request", message: "unknown request type" }
		}
	}

	private toResponse<Response extends TandemCoordinatorResponse>(
		response: Response | TandemCoordinatorError,
	): Response | RemoteRequestError {
		if (!(response instanceof Error)) return response
		console.error(response)
		return { error: "unavailable", message: response.message }
	}

	private validatePull(request: {
		cookie?: Cookie
		scanWindow: ScanWindow<AnySchema>
	}) {
		const { cookie, scanWindow } = request
		if (
			cookie !== undefined &&
			typeof cookie !== "string" &&
			typeof cookie !== "number"
		)
			return "invalid cookie"
		if (!Array.isArray(scanWindow)) return "scan window must be an array"
		if (scanWindow.length > this.limits.maxQueriesPerPull)
			return "too many queries"
	}

	private validatePush(
		request: { mutations: unknown },
		collections: ReadonlySet<string>,
	) {
		const { mutations } = request
		if (!Array.isArray(mutations)) return "mutations must be an array"
		if (mutations.length > this.limits.maxMutationsPerPush)
			return "too many mutations"
		let ops = 0
		for (const mutation of mutations as unknown[]) {
			if (!isRecordObject(mutation)) return "invalid mutation"
			if (!Number.isSafeInteger(mutation.id) || (mutation.id as number) < 1)
				return "invalid mutation id"
			if (!Array.isArray(mutation.ops)) return "invalid mutation ops"
			ops += mutation.ops.length
			if (ops > this.limits.maxOpsPerPush) return "too many operations"
			for (const op of mutation.ops as unknown[]) {
				if (!isRecordObject(op) || typeof op.collection !== "string")
					return "invalid operation"
				if (!collections.has(op.collection)) return "unknown collection"
				if (
					op.type === "set" &&
					isRecordObject(op.value) &&
					op.value.id !== undefined
				)
					continue
				if (op.type === "remove" && op.id !== undefined) continue
				return "invalid operation"
			}
		}
	}
}
