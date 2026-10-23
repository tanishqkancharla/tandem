import * as errore from "errore"
import type { TandemCoordinatorStats } from "./protocol.js"
import { signTandemRequest } from "./signing.js"

export class TandemInvalidationError extends errore.createTaggedError({
	name: "TandemInvalidationError",
	message: "Tandem coordinator request failed: $reason",
}) {}

export type NotifyTandemCoordinatorArgs = {
	/** Coordinator origin, for example `https://sync.example.com`. */
	coordinatorUrl: string
	appId: string
	secret: string
	fetch?: typeof fetch
}

/**
 * Tell the coordinator that the app committed writes outside Tandem. Call it
 * after the database commit succeeds. Connected clients pull current data.
 * Delivery is best effort: clients that miss it converge on their next pull,
 * commit, or reconnect.
 */
export async function notifyTandemCoordinator(
	args: NotifyTandemCoordinatorArgs,
): Promise<{ sockets: number }> {
	const body = JSON.stringify({ at: Date.now() })
	const headers = await signTandemRequest({
		purpose: "invalidate",
		appId: args.appId,
		secret: args.secret,
		body,
	})
	const url = `${args.coordinatorUrl.replace(/\/$/, "")}/apps/${encodeURIComponent(args.appId)}/invalidate`
	const response = await (args.fetch ?? fetch)(url, {
		method: "POST",
		headers: { ...headers, "content-type": "application/json" },
		body,
	}).catch(
		(cause) => new TandemInvalidationError({ reason: "network error", cause }),
	)
	if (response instanceof Error) throw response
	if (!response.ok) {
		throw new TandemInvalidationError({ reason: `HTTP ${response.status}` })
	}
	return (await response.json()) as { sockets: number }
}

/** Read diagnostics from the coordinator object serving an app. */
export async function getTandemCoordinatorStats(
	args: NotifyTandemCoordinatorArgs,
): Promise<TandemCoordinatorStats> {
	const body = JSON.stringify({ at: Date.now() })
	const headers = await signTandemRequest({
		purpose: "stats",
		appId: args.appId,
		secret: args.secret,
		body,
	})
	const url = `${args.coordinatorUrl.replace(/\/$/, "")}/apps/${encodeURIComponent(args.appId)}/stats`
	const response = await (args.fetch ?? fetch)(url, {
		method: "POST",
		headers: { ...headers, "content-type": "application/json" },
		body,
	}).catch(
		(cause) => new TandemInvalidationError({ reason: "network error", cause }),
	)
	if (response instanceof Error) throw response
	if (!response.ok) {
		throw new TandemInvalidationError({ reason: `HTTP ${response.status}` })
	}
	return (await response.json()) as TandemCoordinatorStats
}
