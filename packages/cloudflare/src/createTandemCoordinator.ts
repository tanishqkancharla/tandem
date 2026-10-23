import * as errore from "errore"
import { TandemBridgeStorage } from "./bridge.js"
import { tandemKeepAliveRequest, tandemKeepAliveResponse } from "./protocol.js"
import { verifyTandemClientToken, verifyTandemRequest } from "./signing.js"
import {
	TandemCoordinatorCore,
	type TandemCoordinatorLimits,
	type TandemSocketAttachment,
} from "./TandemCoordinatorCore.js"

/** Operator configuration for one app served by the coordinator. */
export type TandemCoordinatorAppConfig = {
	/** The app's bridge endpoint, served by `handleTandemBridgeRequest`. */
	bridgeUrl: string
	/** Random secret shared only with that app's server. */
	secret: string
}

export type TandemCoordinatorEnv = {
	/** JSON object of appId -> TandemCoordinatorAppConfig. Store it as a secret. */
	TANDEM_APPS: string
	/** Set to "true" only for local development against http:// bridges. */
	TANDEM_ALLOW_INSECURE_BRIDGE?: string
} & Record<string, unknown>

export type CreateTandemCoordinatorArgs = {
	/**
	 * Durable Object namespace binding name in the coordinator's Wrangler config.
	 * @default "TANDEM_COORDINATOR"
	 */
	binding?: string
	limits?: Partial<TandemCoordinatorLimits>
	/** Intercept bridge fetches, for example to add tracing. */
	fetch?: typeof fetch
}

/* Minimal Cloudflare runtime shapes, so the package does not require global Workers types. */
type DurableObjectWebSocket = WebSocket & {
	serializeAttachment(value: unknown): void
	deserializeAttachment(): unknown
}
type DurableObjectStateLike = {
	acceptWebSocket(socket: WebSocket): void
	getWebSockets(): DurableObjectWebSocket[]
	setWebSocketAutoResponse?(pair: unknown): void
	storage: {
		get<T>(key: string): Promise<T | undefined>
		put(key: string, value: unknown): Promise<void>
	}
}
type DurableObjectNamespaceLike = {
	idFromName(name: string): unknown
	get(id: unknown): { fetch(request: Request): Promise<Response> }
}
declare const WebSocketPair: {
	new (): { 0: WebSocket; 1: DurableObjectWebSocket }
}
declare const WebSocketRequestResponsePair: {
	new (request: string, response: string): unknown
}

const appIdPattern = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/
const clientIdPattern = /^[A-Za-z0-9_-]{1,128}$/
const internalHeaders = {
	appId: "x-tandem-internal-app",
	attachment: "x-tandem-internal-attachment",
} as const

function json(status: number, body: unknown) {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json" },
	})
}

function readApp(env: TandemCoordinatorEnv, appId: string) {
	if (!appIdPattern.test(appId)) return undefined
	const apps = errore.try(
		() =>
			JSON.parse(env.TANDEM_APPS) as Record<
				string,
				TandemCoordinatorAppConfig | undefined
			>,
	)
	if (apps instanceof Error) {
		console.error("TANDEM_APPS is not valid JSON", apps)
		return undefined
	}
	const config = Object.hasOwn(apps, appId) ? apps[appId] : undefined
	if (!config || typeof config.secret !== "string" || config.secret.length < 32)
		return undefined
	const url = errore.try(() => new URL(config.bridgeUrl))
	if (url instanceof Error) return undefined
	if (url.protocol !== "https:" && env.TANDEM_ALLOW_INSECURE_BRIDGE !== "true")
		return undefined
	return config
}

/**
 * Verify a WebSocket upgrade's token and build the server-owned socket identity.
 * @internal Exported for the coordinator tests.
 */
export async function authorizeTandemConnection(args: {
	appId: string
	url: URL
	secret: string
}): Promise<TandemSocketAttachment | Response> {
	const token = args.url.searchParams.get("token") ?? ""
	const clientId = args.url.searchParams.get("clientId") ?? ""
	if (!clientIdPattern.test(clientId))
		return json(400, { error: "invalid clientId" })
	const claims = await verifyTandemClientToken({
		token,
		appId: args.appId,
		secret: args.secret,
	})
	if (claims instanceof Error) return json(401, { error: "unauthorized" })
	return {
		connectionId: crypto.randomUUID(),
		appId: args.appId,
		subject: claims.sub,
		// Namespace by subject so users cannot share mutation counters.
		clientId: `${encodeURIComponent(claims.sub)}:${clientId}`,
		expiresAt: claims.exp,
	}
}

/** The Durable Object class returned by `createTandemCoordinator`. */
export type TandemCoordinatorClass = new (
	ctx: DurableObjectStateLike,
	env: TandemCoordinatorEnv,
) => {
	fetch(request: Request): Promise<Response>
	webSocketMessage(
		socket: DurableObjectWebSocket,
		message: string | ArrayBuffer,
	): Promise<void>
	webSocketClose(
		socket: DurableObjectWebSocket,
		code: number,
		reason: string,
	): Promise<void>
	webSocketError(socket: DurableObjectWebSocket): Promise<void>
}

export type TandemCoordinatorWorker = {
	fetch(request: Request, env: TandemCoordinatorEnv): Promise<Response>
}

/**
 * Create the coordinator Worker and its Durable Object class. Export both from
 * the coordinator's entry module:
 *
 * ```ts
 * const coordinator = createTandemCoordinator()
 * export const TandemCoordinator = coordinator.TandemCoordinator
 * export default coordinator.worker
 * ```
 */
export function createTandemCoordinator(
	args: CreateTandemCoordinatorArgs = {},
): {
	TandemCoordinator: TandemCoordinatorClass
	worker: TandemCoordinatorWorker
} {
	const binding = args.binding ?? "TANDEM_COORDINATOR"

	class TandemCoordinator {
		#core?: TandemCoordinatorCore
		readonly #ctx: DurableObjectStateLike
		readonly #env: TandemCoordinatorEnv

		constructor(ctx: DurableObjectStateLike, env: TandemCoordinatorEnv) {
			this.#ctx = ctx
			this.#env = env
			// Keepalive pings are answered by the runtime without waking the object.
			ctx.setWebSocketAutoResponse?.(
				new WebSocketRequestResponsePair(
					tandemKeepAliveRequest,
					tandemKeepAliveResponse,
				),
			)
		}

		async fetch(request: Request): Promise<Response> {
			const appId = request.headers.get(internalHeaders.appId)
			if (!appId) return json(400, { error: "missing app" })
			const core = await this.#getCore(appId)
			if (core instanceof Response) return core

			const url = new URL(request.url)
			if (url.pathname === "/connect") {
				const attachment = JSON.parse(
					request.headers.get(internalHeaders.attachment) ?? "null",
				) as TandemSocketAttachment
				const pair = new WebSocketPair()
				const server = pair[1]
				this.#ctx.acceptWebSocket(server)
				server.serializeAttachment(attachment)
				await core.open(server, attachment)
				return new Response(null, {
					status: 101,
					webSocket: pair[0],
				} as ResponseInit)
			}
			if (url.pathname === "/invalidate") {
				const sockets = await core.invalidate()
				if (sockets instanceof Error) {
					console.error(sockets)
					return json(503, { error: "coordinator unavailable" })
				}
				return json(200, { ok: true, sockets })
			}
			if (url.pathname === "/stats") return json(200, core.stats())
			return json(404, { error: "not found" })
		}

		async webSocketMessage(
			socket: DurableObjectWebSocket,
			message: string | ArrayBuffer,
		) {
			const attachment =
				socket.deserializeAttachment() as TandemSocketAttachment
			const core = await this.#getCore(attachment.appId)
			if (core instanceof Response) {
				socket.close(1011, "coordinator unavailable")
				return
			}
			await core.message(socket, attachment, message)
		}

		webSocketClose(
			socket: DurableObjectWebSocket,
			code: number,
			reason: string,
		): Promise<void> {
			const attachment =
				socket.deserializeAttachment() as TandemSocketAttachment
			this.#core?.close(attachment)
			// Complete the closing handshake on runtimes without automatic replies.
			const closed = errore.try(() =>
				socket.close(code === 1005 || code === 1006 ? 1000 : code, reason),
			)
			if (closed instanceof Error && socket.readyState !== WebSocket.CLOSED) {
				console.warn("Tandem coordinator could not close a socket", closed)
			}
			return Promise.resolve()
		}

		webSocketError(socket: DurableObjectWebSocket): Promise<void> {
			const attachment =
				socket.deserializeAttachment() as TandemSocketAttachment
			this.#core?.close(attachment)
			return Promise.resolve()
		}

		async #getCore(appId: string) {
			if (this.#core) {
				return this.#core.appId === appId
					? this.#core
					: json(403, { error: "app mismatch" })
			}
			const config = readApp(this.#env, appId)
			if (!config) return json(404, { error: "unknown app" })
			// Durable identity check: an object serves exactly one app for its lifetime.
			const storedAppId = await this.#ctx.storage.get<string>("appId")
			if (storedAppId === undefined) await this.#ctx.storage.put("appId", appId)
			else if (storedAppId !== appId)
				return json(403, { error: "app mismatch" })
			if (this.#core) return this.#core

			let core: TandemCoordinatorCore | undefined
			const storage = new TandemBridgeStorage({
				appId,
				bridgeUrl: config.bridgeUrl,
				secret: config.secret,
				fetch: args.fetch,
				onRequest: () => core?.recordBridgeRequest(),
			})
			core = new TandemCoordinatorCore({
				appId,
				storage,
				limits: args.limits,
				getSockets: () =>
					this.#ctx.getWebSockets().map((socket) => ({
						socket,
						attachment:
							socket.deserializeAttachment() as TandemSocketAttachment,
					})),
			})
			this.#core = core
			return core
		}
	}

	const worker = {
		async fetch(
			request: Request,
			env: TandemCoordinatorEnv,
		): Promise<Response> {
			const url = new URL(request.url)
			const match = /^\/apps\/([^/]+)\/(connect|invalidate|stats)$/.exec(
				url.pathname,
			)
			if (url.pathname === "/health") return json(200, { ok: true })
			if (!match) return json(404, { error: "not found" })
			const [, appId, action] = match as unknown as [
				string,
				string,
				"connect" | "invalidate" | "stats",
			]
			const config = readApp(env, appId)
			// Unknown apps and bad credentials look the same to callers.
			if (!config) return json(401, { error: "unauthorized" })
			const namespace = env[binding] as DurableObjectNamespaceLike
			const stub = namespace.get(namespace.idFromName(`app:${appId}`))
			const internalUrl = new URL(`https://coordinator/${action}`)

			if (action === "connect") {
				if (request.headers.get("upgrade")?.toLowerCase() !== "websocket")
					return json(426, { error: "expected a WebSocket upgrade" })
				const attachment = await authorizeTandemConnection({
					appId,
					url,
					secret: config.secret,
				})
				if (attachment instanceof Response) return attachment
				const headers = new Headers(request.headers)
				headers.set(internalHeaders.appId, appId)
				headers.set(internalHeaders.attachment, JSON.stringify(attachment))
				return stub.fetch(new Request(internalUrl, { headers }))
			}

			if (request.method !== "POST") return json(405, { error: "POST only" })
			const body = await request.text()
			const authError = await verifyTandemRequest({
				purpose: action,
				appId,
				secret: config.secret,
				headers: request.headers,
				body,
			})
			if (authError) return json(401, { error: "unauthorized" })
			return stub.fetch(
				new Request(internalUrl, {
					method: "POST",
					headers: { [internalHeaders.appId]: appId },
				}),
			)
		},
	}

	return { TandemCoordinator, worker }
}
