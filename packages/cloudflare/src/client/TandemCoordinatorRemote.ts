import type {
	AnySchema,
	ClientApi,
	ClientId,
	RemoteApi,
	RemoteUnavailableError,
	TandemClient,
} from "@tanishqkancharla/tandem-core"
import * as errore from "errore"
import {
	tandemKeepAliveRequest,
	tandemKeepAliveResponse,
	type TandemCoordinatorMessage,
	type TandemCoordinatorRequest,
	type TandemCoordinatorResponse,
	type TandemCoordinatorStats,
} from "../protocol.js"

type WebSocketConstructor = new (url: string) => WebSocket

export type TandemCoordinatorRemoteArgs = {
	/** Coordinator app URL, for example `wss://sync.example.com/apps/my-app`. */
	url: string
	/** Fetch a short-lived client token from the app's own server. Called on every connect. */
	getToken: () => Promise<string>
	/**
	 * Milliseconds between keepalive frames on idle sockets. The coordinator's
	 * runtime answers them without waking the Durable Object. `false` disables them.
	 * @default 30_000
	 */
	keepAliveInterval?: number | false
	/** @default 30_000 */
	requestTimeout?: number
	WebSocket?: WebSocketConstructor
}

export type TandemCoordinatorDisconnect = {
	clientId: ClientId
	code: number
	reason: string
}

type PendingRequest = {
	resolve: (
		response: TandemCoordinatorResponse<AnySchema> | RemoteUnavailableError,
	) => void
	timeout: ReturnType<typeof setTimeout>
}

type Session = {
	socket: WebSocket
	pending: Map<number, PendingRequest>
	keepAlive?: ReturnType<typeof setInterval>
	closedByClient: boolean
}

function unavailable(message: string): RemoteUnavailableError {
	return { error: "unavailable", message }
}

/**
 * Tandem remote over a coordinator WebSocket. Pushes, pulls, and pokes share
 * one socket per client identity. A dropped socket is reported through
 * `onDisconnect`; use `keepTandemClientConnected` to reconnect the client,
 * which pulls missed changes and resends pending writes.
 */
export class TandemCoordinatorRemote<
	Schema extends AnySchema,
> implements RemoteApi<Schema> {
	private readonly sessions = new Map<ClientId, Session>()
	private readonly disconnectListeners = new Set<
		(event: TandemCoordinatorDisconnect) => void
	>()
	private nextRequestId = 1

	constructor(private readonly args: TandemCoordinatorRemoteArgs) {}

	connect: RemoteApi<Schema>["connect"] = async ({
		clientId,
		poke,
	}: ClientApi) => {
		const token = await this.args
			.getToken()
			.catch((cause) => new Error("Could not fetch a Tandem token", { cause }))
		if (token instanceof Error) return unavailable(token.message)

		const url = new URL(`${this.args.url.replace(/\/$/, "")}/connect`)
		url.searchParams.set("clientId", clientId)
		url.searchParams.set("token", token)
		const SocketConstructor = this.args.WebSocket ?? WebSocket
		const socket = errore.try(() => new SocketConstructor(url.toString()))
		if (socket instanceof Error) return unavailable(socket.message)

		const session: Session = {
			socket,
			pending: new Map(),
			closedByClient: false,
		}
		const opened = await new Promise<boolean>((resolve) => {
			socket.addEventListener("open", () => resolve(true), { once: true })
			socket.addEventListener("close", () => resolve(false), { once: true })
		})
		if (!opened)
			return unavailable("Could not connect to the Tandem coordinator")

		const replaced = this.sessions.get(clientId)
		if (replaced) {
			replaced.closedByClient = true
			replaced.socket.close(1000, "replaced")
		}
		this.sessions.set(clientId, session)
		socket.addEventListener("message", (event) => {
			if (event.data === tandemKeepAliveResponse) return
			const message = errore.try(
				() =>
					JSON.parse(String(event.data)) as TandemCoordinatorMessage<Schema>,
			)
			if (message instanceof Error) {
				console.warn("Ignoring an invalid Tandem coordinator message", message)
				return
			}
			if (message.type === "poke") {
				void poke()
				return
			}
			const pending = session.pending.get(message.requestId)
			if (!pending) return
			session.pending.delete(message.requestId)
			clearTimeout(pending.timeout)
			pending.resolve(message.response as TandemCoordinatorResponse<AnySchema>)
		})
		socket.addEventListener("close", (event) => {
			if (session.keepAlive) clearInterval(session.keepAlive)
			for (const pending of session.pending.values()) {
				clearTimeout(pending.timeout)
				pending.resolve(unavailable("Tandem coordinator connection closed"))
			}
			session.pending.clear()
			if (this.sessions.get(clientId) === session)
				this.sessions.delete(clientId)
			if (session.closedByClient) return
			for (const listener of this.disconnectListeners) {
				listener({ clientId, code: event.code, reason: event.reason })
			}
		})
		const keepAliveInterval = this.args.keepAliveInterval ?? 30_000
		if (keepAliveInterval !== false) {
			session.keepAlive = setInterval(() => {
				if (socket.readyState === socket.OPEN)
					socket.send(tandemKeepAliveRequest)
			}, keepAliveInterval)
		}

		return () => {
			session.closedByClient = true
			socket.close(1000, "disconnected")
			return Promise.resolve()
		}
	}

	push: RemoteApi<Schema>["push"] = async ({ clientId, mutations }) => {
		const response = await this.request(clientId, { type: "push", mutations })
		return response as Awaited<ReturnType<RemoteApi<Schema>["push"]>>
	}

	pull: RemoteApi<Schema>["pull"] = async ({
		clientId,
		cookie,
		scanWindow,
	}) => {
		const response = await this.request(clientId, {
			type: "pull",
			cookie,
			scanWindow,
		})
		return response as Awaited<ReturnType<RemoteApi<Schema>["pull"]>>
	}

	/** Diagnostics from the coordinator instance serving this client. */
	async stats(clientId: ClientId): Promise<TandemCoordinatorStats> {
		const response = await this.request(clientId, { type: "stats" })
		if ("error" in response)
			throw new Error(`Tandem stats failed: ${response.error}`)
		return response as TandemCoordinatorStats
	}

	/** Called when an open coordinator socket closes without `disconnect`. */
	onDisconnect(listener: (event: TandemCoordinatorDisconnect) => void) {
		this.disconnectListeners.add(listener)
		return () => {
			this.disconnectListeners.delete(listener)
		}
	}

	private request(
		clientId: ClientId,
		request: DistributiveOmit<TandemCoordinatorRequest<Schema>, "requestId">,
	): Promise<TandemCoordinatorResponse<Schema> | RemoteUnavailableError> {
		const session = this.sessions.get(clientId)
		if (!session || session.socket.readyState !== session.socket.OPEN) {
			return Promise.resolve(
				unavailable("Not connected to the Tandem coordinator"),
			)
		}
		const requestId = this.nextRequestId++
		return new Promise((resolve) => {
			const timeout = setTimeout(() => {
				session.pending.delete(requestId)
				resolve(unavailable("Tandem coordinator request timed out"))
			}, this.args.requestTimeout ?? 30_000)
			session.pending.set(requestId, {
				resolve: resolve as PendingRequest["resolve"],
				timeout,
			})
			const sent = errore.try(() =>
				session.socket.send(JSON.stringify({ ...request, requestId })),
			)
			if (sent instanceof Error) {
				session.pending.delete(requestId)
				clearTimeout(timeout)
				resolve(unavailable(sent.message))
			}
		})
	}
}

type DistributiveOmit<T, Key extends PropertyKey> = T extends unknown
	? Omit<T, Key>
	: never

export type KeepTandemClientConnectedArgs = {
	/** @default 500 */
	initialDelay?: number
	/** @default 30_000 */
	maxDelay?: number
	/** Called after a dropped client reconnects and has pulled. */
	onReconnect?: () => void
	onError?: (error: unknown) => void
}

/**
 * Reconnect a client after its coordinator socket drops. Each reconnect pulls
 * before pushing pending writes, so missed invalidations and lost push
 * responses converge. Returns a function that stops reconnecting.
 */
export function keepTandemClientConnected<Schema extends AnySchema>(
	client: TandemClient<Schema>,
	remote: TandemCoordinatorRemote<Schema>,
	args: KeepTandemClientConnectedArgs = {},
): () => void {
	const initialDelay = args.initialDelay ?? 500
	const maxDelay = args.maxDelay ?? 30_000
	let stopped = false
	let timer: ReturnType<typeof setTimeout> | undefined
	let reconnecting = false
	// A drop during an attempt can belong to the socket that attempt opened.
	let droppedDuringAttempt = false

	const reconnect = (delay: number) => {
		if (stopped) return
		if (reconnecting) {
			droppedDuringAttempt = true
			return
		}
		reconnecting = true
		droppedDuringAttempt = false
		timer = setTimeout(async () => {
			const result = await client
				.disconnect()
				.then(() => client.connect())
				.catch((error: unknown) => error)
			reconnecting = false
			if (stopped) return
			if (typeof result === "function") {
				if (droppedDuringAttempt) {
					reconnect(initialDelay)
					return
				}
				args.onReconnect?.()
				return
			}
			args.onError?.(result)
			reconnect(Math.min(delay * 2, maxDelay))
		}, delay)
	}

	const unsubscribe = remote.onDisconnect((event) => {
		if (event.clientId !== client.clientId) return
		reconnect(initialDelay)
	})
	return () => {
		stopped = true
		if (timer) clearTimeout(timer)
		unsubscribe()
	}
}
