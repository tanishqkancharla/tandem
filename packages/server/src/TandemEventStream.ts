import {
	PokeApi,
	type AnySchema,
	type ClientId,
	type PokePayload,
	type RemoteApi,
	type RuntimeSchemaDefinition,
} from "@tanishqkancharla/tandem-core"
import * as errore from "errore"
import { TandemServerError } from "./TandemServerError.js"

export type TandemEventStreamArgs<Schema extends AnySchema = AnySchema> = {
	/** Registers the stream for pokes, such as a `TandemServer` or a wrapper around one. */
	remote: Pick<RemoteApi<Schema>, "connect">
	clientId: ClientId
	/** Applies collection codecs to poke records. Without it, records are sent as JSON. */
	schema?: RuntimeSchemaDefinition<Schema>
	/** Aborts when the request ends. Cancelling the response body also closes the stream. */
	signal?: AbortSignal
	/** Milliseconds between keep-alive comments. Defaults to 15 seconds. */
	heartbeatInterval?: number
}

const encoder = new TextEncoder()
const readyFrame = encoder.encode("event: ready\ndata:\n\n")
const pokeFrame = encoder.encode("event: poke\ndata:\n\n")

function payloadFrame<Schema extends AnySchema>(
	payload: PokePayload<Schema>,
	schema: RuntimeSchemaDefinition<Schema> | undefined,
) {
	const data = errore.try({
		try: () =>
			JSON.stringify(schema ? PokeApi.codec(schema).encode(payload) : payload),
		catch: (cause) => new TandemServerError({ operation: "poke", cause }),
	})
	if (data instanceof Error) return data
	// JSON escapes newlines, so the data fits on one line.
	return encoder.encode(`event: poke\ndata: ${data}\n\n`)
}
const heartbeatFrame = encoder.encode(": keep-alive\n\n")

/**
 * Streams pokes to one client as server-sent events.
 *
 * Sends `ready` after the poke callback is registered and `poke` whenever
 * committed data may have changed. A poke's data is its JSON payload, or empty
 * for a bare poke. Clients pull over the normal sync transport in response.
 */
export async function createTandemEventStreamResponse<
	Schema extends AnySchema = AnySchema,
>({
	remote,
	clientId,
	schema,
	signal,
	heartbeatInterval = 15_000,
}: TandemEventStreamArgs<Schema>): Promise<Response> {
	let controller!: ReadableStreamDefaultController<Uint8Array>
	let closed = false
	// A reader that falls behind gets one pending bare poke, not one frame per
	// commit. Its payloads are dropped; the pull it starts delivers them.
	let pokePending = false

	const enqueue = (frame: Uint8Array) => {
		if (!closed) controller.enqueue(frame)
	}
	const hasCapacity = () =>
		controller.desiredSize !== null && controller.desiredSize > 0
	const poke = (payload?: PokePayload<Schema>) => {
		if (!hasCapacity()) {
			pokePending = true
			return Promise.resolve()
		}
		const frame = payload ? payloadFrame(payload, schema) : pokeFrame
		if (frame instanceof Error) {
			console.error(frame)
			enqueue(pokeFrame)
		} else enqueue(frame)
		return Promise.resolve()
	}

	const body = new ReadableStream<Uint8Array>({
		start: (streamController) => {
			controller = streamController
		},
		pull: () => {
			if (!pokePending) return
			pokePending = false
			enqueue(pokeFrame)
		},
		cancel: () => close(),
	})

	const connected = await remote
		.connect({ clientId, poke })
		.catch((cause) => new TandemServerError({ operation: "connect", cause }))
	if (connected instanceof Error || typeof connected !== "function") {
		// The response carries only the message, so keep the cause for the operator.
		if (connected instanceof Error) console.error(connected)
		return Response.json(
			{ error: "unavailable", message: connected.message },
			{ status: 503 },
		)
	}

	// Queued frames already keep the connection busy, so a stalled reader skips heartbeats.
	const heartbeat = setInterval(() => {
		if (hasCapacity()) enqueue(heartbeatFrame)
	}, heartbeatInterval)
	const close = () => {
		if (closed) return
		closed = true
		clearInterval(heartbeat)
		signal?.removeEventListener("abort", onAbort)
		// The consumer may have cancelled the body already.
		errore.try(() => controller.close())
		void connected().catch((cause: unknown) => {
			console.error(new TandemServerError({ operation: "disconnect", cause }))
		})
	}
	const onAbort = () => close()
	if (signal?.aborted) close()
	else {
		signal?.addEventListener("abort", onAbort, { once: true })
		enqueue(readyFrame)
	}

	return new Response(body, {
		headers: {
			"content-type": "text/event-stream; charset=utf-8",
			"cache-control": "no-cache, no-transform",
			"x-accel-buffering": "no",
		},
	})
}
