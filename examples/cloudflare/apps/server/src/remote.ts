import {
	connectTandemEventSource,
	MutationApi,
	type RemoteApi,
	type ClientApi,
	type ClientId,
} from "@tanishqkancharla/tandem-core"
import * as errore from "errore"
import { schema, type AppSchema } from "./schema.js"

class SyncRemoteError extends errore.createTaggedError({
	name: "SyncRemoteError",
	message: "Sync HTTP failed to $action",
}) {}

export function createRemote(baseUrl: string): RemoteApi<AppSchema> {
	const pokes = new Map<ClientId, ClientApi<AppSchema>["poke"]>()
	async function call<Action extends "push" | "pull">(
		action: Action,
		args: unknown,
	): Promise<Awaited<ReturnType<RemoteApi<AppSchema>[Action]>>> {
		const response = await fetch(new URL("/api/tandem", baseUrl), {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ action, args }),
		}).catch((cause) => new SyncRemoteError({ action, cause }))
		if (response instanceof Error) throw response
		if (!response.ok) throw new SyncRemoteError({ action })
		const body = await (
			response.json() as Promise<
				Awaited<ReturnType<RemoteApi<AppSchema>[Action]>>
			>
		).catch((cause) => new SyncRemoteError({ action, cause }))
		if (body instanceof Error) throw body
		return body
	}
	return {
		connect: ({ clientId, poke }) => {
			const url = new URL("/api/tandem/events", baseUrl)
			url.searchParams.set("clientId", clientId)
			const disconnect = connectTandemEventSource({ url, poke, schema })
			pokes.set(clientId, poke)
			return Promise.resolve(() => {
				if (pokes.get(clientId) === poke) pokes.delete(clientId)
				return disconnect()
			})
		},
		push: async (args) => {
			const result = await call("push", {
				...args,
				mutations: args.mutations.map((mutation) =>
					MutationApi.codec(schema).encode(mutation),
				),
			})
			if ("error" in result) return result
			// Confirm this writer's mutation even while its SSE stream is down.
			void pokes.get(args.clientId)?.()
			return result
		},
		pull: (args) => call("pull", args),
	}
}
