import type { AnyRelations, AnySchema } from "@tanishqkancharla/tandem-core"
import type {
	TandemServerStorageApi,
	TandemTuple,
} from "@tanishqkancharla/tandem-server"
import * as errore from "errore"
import type { ScanStorageArgs, WriteOps } from "tuple-database"
import { signTandemRequest, verifyTandemRequest } from "./signing.js"

/** Requests the coordinator sends to an app's bridge endpoint. */
export type TandemBridgeRequest =
	| { op: "describe" }
	| { op: "scan"; args: ScanStorageArgs }
	| { op: "commit"; writes: WriteOps<TandemTuple<AnySchema>> }

export type TandemBridgeDescription = {
	collections: string[]
	relations: AnyRelations<AnySchema>
}

/** Bridge responses larger than this are rejected by the coordinator. */
export const maxBridgeResponseBytes = 16 * 1024 * 1024
const maxBridgeRequestBytes = 8 * 1024 * 1024
const bridgeTimeoutMs = 15_000

export class TandemBridgeError extends errore.createTaggedError({
	name: "TandemBridgeError",
	message: "Tandem bridge $operation failed: $reason",
}) {}

export type TandemBridgeStorageArgs = {
	appId: string
	bridgeUrl: string
	secret: string
	fetch?: typeof fetch
	/** Called after each bridge round trip, for coordinator statistics. */
	onRequest?: () => void
}

/**
 * Coordinator-side storage that forwards Tandem's tuple reads and atomic commits
 * to the app's own database through its authenticated bridge endpoint.
 */
export class TandemBridgeStorage implements TandemServerStorageApi<AnySchema> {
	private readonly listeners = new Set<() => void>()

	constructor(private readonly args: TandemBridgeStorageArgs) {}

	async describe(): Promise<TandemBridgeDescription | TandemBridgeError> {
		const result: object | TandemBridgeError = await this.request({
			op: "describe",
		})
		if (result instanceof Error) return result
		const description = result as Partial<TandemBridgeDescription>
		if (
			!Array.isArray(description.collections) ||
			!description.collections.every((name) => typeof name === "string") ||
			typeof description.relations !== "object" ||
			description.relations === null
		) {
			return new TandemBridgeError({
				operation: "describe",
				reason: "invalid description",
			})
		}
		return description as TandemBridgeDescription
	}

	async scan(args?: ScanStorageArgs): Promise<TandemTuple<AnySchema>[]> {
		const result = await this.request({ op: "scan", args: args ?? {} })
		if (result instanceof Error) throw result
		const tuples = (result as { tuples?: unknown }).tuples
		if (!Array.isArray(tuples)) {
			throw new TandemBridgeError({
				operation: "scan",
				reason: "invalid tuples",
			})
		}
		return tuples as TandemTuple<AnySchema>[]
	}

	async commit(writes: WriteOps<TandemTuple<AnySchema>>): Promise<void> {
		const result = await this.request({ op: "commit", writes })
		if (result instanceof Error) throw result
	}

	/** Invalidation requests from the app notify TandemServer through this hook. */
	subscribe(onChange: () => void) {
		this.listeners.add(onChange)
		return () => {
			this.listeners.delete(onChange)
		}
	}

	notifyChanged() {
		for (const listener of this.listeners) listener()
	}

	close(): Promise<void> {
		this.listeners.clear()
		return Promise.resolve()
	}

	private async request(
		request: TandemBridgeRequest,
	): Promise<object | TandemBridgeError> {
		const body = JSON.stringify(request)
		const headers = await signTandemRequest({
			purpose: "bridge",
			appId: this.args.appId,
			secret: this.args.secret,
			body,
		})
		const response = await (this.args.fetch ?? fetch)(this.args.bridgeUrl, {
			method: "POST",
			headers: { ...headers, "content-type": "application/json" },
			body,
			redirect: "manual",
			signal: AbortSignal.timeout(bridgeTimeoutMs),
		}).catch(
			(cause) =>
				new TandemBridgeError({
					operation: request.op,
					reason: "network error",
					cause,
				}),
		)
		this.args.onRequest?.()
		if (response instanceof Error) return response
		const text = await response.text().catch(
			(cause) =>
				new TandemBridgeError({
					operation: request.op,
					reason: "could not read response",
					cause,
				}),
		)
		if (text instanceof Error) return text
		if (text.length > maxBridgeResponseBytes) {
			return new TandemBridgeError({
				operation: request.op,
				reason: "response too large",
			})
		}
		if (!response.ok) {
			return new TandemBridgeError({
				operation: request.op,
				reason: `HTTP ${response.status}: ${text.slice(0, 200)}`,
			})
		}
		const parsed = errore.try(() => JSON.parse(text) as unknown)
		if (parsed instanceof Error || typeof parsed !== "object" || !parsed) {
			return new TandemBridgeError({
				operation: request.op,
				reason: "invalid JSON response",
			})
		}
		return parsed
	}
}

export type TandemBridgeHandlerArgs<Schema extends AnySchema> = {
	appId: string
	/** Shared with the coordinator's app configuration. Keep it server-side. */
	secret: string
	storage: TandemServerStorageApi<Schema>
	/** Collections clients may sync. Writes to anything else are rejected. */
	collections: readonly string[]
	relations?: AnyRelations<Schema>
}

function jsonResponse(status: number, body: unknown) {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json" },
	})
}

function isAllowedKey(key: unknown, collections: ReadonlySet<string>) {
	if (!Array.isArray(key)) return false
	if (key[0] === "client") return key.length === 2 && typeof key[1] === "string"
	return key[0] === "record" && collections.has(key[1] as string)
}

/**
 * Validates a commit from the coordinator. Coordinator commits come only from
 * client pushes, so each must advance exactly one client acknowledgement. This
 * also makes a replayed request fail the storage acknowledgement check.
 */
function validateCommit(
	writes: WriteOps<TandemTuple<AnySchema>>,
	collections: ReadonlySet<string>,
) {
	const sets = Array.isArray(writes.set) ? writes.set : undefined
	const removes = Array.isArray(writes.remove) ? writes.remove : []
	if (!sets) return "commit needs set operations"
	if (!sets.every((write) => isAllowedKey(write?.key, collections)))
		return "commit writes an unknown collection"
	if (!removes.every((key) => isAllowedKey(key, collections)))
		return "commit removes from an unknown collection"
	if (removes.some((key) => key[0] === "client"))
		return "commit cannot remove client acknowledgements"
	const clientWrites = sets.filter((write) => write.key[0] === "client")
	if (clientWrites.length !== 1)
		return "commit must advance exactly one client acknowledgement"
}

/**
 * Serve the coordinator's storage bridge from the app's own server (for example a
 * Worker with a D1 binding). Mount it on a dedicated POST route.
 */
export async function handleTandemBridgeRequest<Schema extends AnySchema>(
	request: Request,
	args: TandemBridgeHandlerArgs<Schema>,
): Promise<Response> {
	if (request.method !== "POST")
		return jsonResponse(405, { error: "POST only" })
	const declaredLength = Number(request.headers.get("content-length") ?? 0)
	if (declaredLength > maxBridgeRequestBytes) {
		return jsonResponse(413, { error: "request too large" })
	}
	const body = await request.text()
	if (body.length > maxBridgeRequestBytes) {
		return jsonResponse(413, { error: "request too large" })
	}
	const authError = await verifyTandemRequest({
		purpose: "bridge",
		appId: args.appId,
		secret: args.secret,
		headers: request.headers,
		body,
	})
	if (authError) return jsonResponse(401, { error: "unauthorized" })

	const parsed = errore.try(() => JSON.parse(body) as TandemBridgeRequest)
	if (parsed instanceof Error || typeof parsed !== "object" || !parsed) {
		return jsonResponse(400, { error: "invalid JSON" })
	}
	const collections = new Set(args.collections)
	switch (parsed.op) {
		case "describe":
			return jsonResponse(200, {
				collections: [...collections],
				relations: args.relations ?? {},
			} satisfies TandemBridgeDescription)
		case "scan": {
			const tuples = await args.storage.scan(parsed.args).catch(
				(cause) =>
					new TandemBridgeError({
						operation: "scan",
						reason: "storage",
						cause,
					}),
			)
			if (tuples instanceof Error) {
				console.error(tuples)
				return jsonResponse(500, { error: "scan failed" })
			}
			return jsonResponse(200, {
				tuples: tuples.filter(
					(tuple) =>
						tuple.key[0] === "client" ||
						collections.has(tuple.key[1] as string),
				),
			})
		}
		case "commit": {
			const invalid = validateCommit(parsed.writes ?? {}, collections)
			if (invalid) return jsonResponse(400, { error: invalid })
			const committed = await args.storage
				.commit(parsed.writes as WriteOps<TandemTuple<Schema>>)
				.catch(
					(cause) =>
						new TandemBridgeError({
							operation: "commit",
							reason: "storage",
							cause,
						}),
				)
			if (committed instanceof Error) {
				console.error(committed)
				return jsonResponse(409, { error: "commit rejected" })
			}
			return jsonResponse(200, { ok: true })
		}
		default:
			return jsonResponse(400, { error: "unknown operation" })
	}
}
