import * as errore from "errore"
import type { AnySchema, RuntimeSchemaDefinition } from "../schema/Schema.js"
import type { AsyncUnsubscribe } from "../utils/typeUtils.js"
import { type ClientApi, PokeApi, type PokePayload } from "./SyncEngine.js"

export type TandemEventSourceArgs<Schema extends AnySchema = AnySchema> = {
	/** An event stream such as one served by `createTandemEventStreamResponse`. */
	url: string | URL
	poke: ClientApi<Schema>["poke"]
	/** Decodes poke records with collection codecs. Pass the schema the server encodes with. */
	schema?: RuntimeSchemaDefinition<Schema>
	/** Milliseconds between fallback pulls, or `null` to disable them. Defaults to 60 seconds. */
	pullInterval?: number | null
	/** Milliseconds before reopening a stream the browser stopped retrying. Defaults to 5 seconds. */
	reconnectDelay?: number
	eventSourceInit?: EventSourceInit
}

class TandemEventSourceError extends errore.createTaggedError({
	name: "TandemEventSourceError",
	message: "Could not read a poke payload",
}) {}

function readPayload<Schema extends AnySchema>(
	data: unknown,
	schema: RuntimeSchemaDefinition<Schema> | undefined,
) {
	if (typeof data !== "string" || data === "") return undefined
	return errore.try({
		try: () => {
			const json: unknown = JSON.parse(data)
			return schema
				? PokeApi.codec(schema).decode(json)
				: (json as PokePayload<Schema>)
		},
		catch: (cause) => new TandemEventSourceError({ cause }),
	})
}

/**
 * Pokes the client from server-sent `ready` and `poke` events.
 *
 * `ready` arrives after every (re)connection, so the client pulls changes it
 * missed while disconnected. A `poke` event's data, when present, is a poke
 * payload. Fallback pulls check for updates whose pokes were lost.
 * Returns a function that closes the stream and stops all timers.
 */
export function connectTandemEventSource<Schema extends AnySchema = AnySchema>({
	url,
	poke,
	schema,
	pullInterval = 60_000,
	reconnectDelay = 5_000,
	eventSourceInit,
}: TandemEventSourceArgs<Schema>): AsyncUnsubscribe {
	let source: EventSource | undefined
	let reconnectTimer: ReturnType<typeof setTimeout> | undefined
	const onReady = () => void poke()
	const onPoke = (event: Event) => {
		const payload = readPayload((event as MessageEvent).data, schema)
		if (payload instanceof Error) {
			// The pull still delivers the records; only the live update is lost.
			console.error(payload)
			void poke()
			return
		}
		void poke(payload)
	}
	const onError = () => {
		// The browser retries dropped streams itself, but not failed responses.
		if (source?.readyState !== EventSource.CLOSED) return
		close()
		reconnectTimer = setTimeout(open, reconnectDelay)
	}
	const open = () => {
		reconnectTimer = undefined
		source = new EventSource(url, eventSourceInit)
		source.addEventListener("ready", onReady)
		source.addEventListener("poke", onPoke)
		source.addEventListener("error", onError)
	}
	const close = () => {
		source?.removeEventListener("ready", onReady)
		source?.removeEventListener("poke", onPoke)
		source?.removeEventListener("error", onError)
		source?.close()
		source = undefined
	}

	open()
	const pullTimer =
		pullInterval === null ? undefined : setInterval(onReady, pullInterval)

	return () => {
		close()
		clearTimeout(reconnectTimer)
		clearInterval(pullTimer)
		return Promise.resolve()
	}
}
