import type {
	AnySchema,
	Cookie,
	Mutation,
	PullResponse,
	PushResponse,
	RemoteRequestError,
	ScanWindow,
} from "@tanishqkancharla/tandem-core"

/** Messages a browser sends on the coordinator WebSocket. */
export type TandemCoordinatorRequest<Schema extends AnySchema = AnySchema> =
	| {
			type: "pull"
			requestId: number
			cookie?: Cookie
			scanWindow: ScanWindow<Schema>
	  }
	| { type: "push"; requestId: number; mutations: Mutation<Schema>[] }
	| { type: "stats"; requestId: number }

export type TandemCoordinatorStats = {
	/** Random per construction; a change while a socket stays open means the object restarted or woke from hibernation. */
	instanceId: string
	constructedAt: number
	sockets: number
	/** Pokes this instance has sent since construction. */
	pokes: number
	/** Bridge round trips this instance has made since construction. */
	bridgeRequests: number
}

export type TandemCoordinatorResponse<Schema extends AnySchema = AnySchema> =
	| PullResponse<Schema>
	| PushResponse
	| RemoteRequestError
	| TandemCoordinatorStats

/** Messages the coordinator sends to a browser. */
export type TandemCoordinatorMessage<Schema extends AnySchema = AnySchema> =
	| {
			type: "response"
			requestId: number
			response: TandemCoordinatorResponse<Schema>
	  }
	| { type: "poke" }

/** Text frame the client sends to keep idle connections open. The runtime answers without waking the object. */
export const tandemKeepAliveRequest = "tandem:ping"
export const tandemKeepAliveResponse = "tandem:pong"

export const tandemCloseCodes = {
	/** The client's token expired. Reconnect with a fresh token. */
	tokenExpired: 4001,
	/** The message violated the protocol or size limits. */
	invalidMessage: 4008,
} as const
