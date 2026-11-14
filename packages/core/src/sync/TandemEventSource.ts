import * as errore from "errore"
import type { AnySchema, RuntimeSchemaDefinition } from "../schema/Schema.js"
import type { AsyncUnsubscribe } from "../utils/typeUtils.js"
import { type ClientApi, PokeApi, type PokePayload } from "./SyncEngine.js"

type TandemEventListener = (event: { data?: unknown }) => void

/** The part of the `EventSource` API that `connectTandemEventSource` uses. */
export type TandemEventSourceApi = {
	readonly readyState: number
	addEventListener(type: string, listener: TandemEventListener): void
	removeEventListener(type: string, listener: TandemEventListener): void
	close(): void
}

export type TandemEventSourceConstructor<Init = { withCredentials?: boolean }> =
	new (url: string, init?: Init) => TandemEventSourceApi

export type TandemEventSourceArgs<
	Schema extends AnySchema = AnySchema,
	Init = { withCredentials?: boolean },
> = {
	/** An event stream such as one served by `createTandemEventStreamResponse`. */
	url: string | { readonly href: string }
	poke: ClientApi<Schema>["poke"]
	/** Decodes poke records with collection codecs. Pass the schema the server encodes with. */
	schema?: RuntimeSchemaDefinition<Schema>
	/** Milliseconds between fallback pulls, or `null` to disable them. Defaults to 60 seconds. */
	pullInterval?: number | null
	/** Milliseconds before reopening a stream the event source stopped retrying. Defaults to 5 seconds. */
	reconnectDelay?: number
	/**
	 * Opens the stream. Pass one, such as `EventSource` from the `eventsource`
	 * package, where the runtime has no global `EventSource`.
	 * @default globalThis.EventSource
	 */
	EventSource?: TandemEventSourceConstructor<Init>
	/** Options for the `EventSource` constructor, such as `withCredentials`. */
	eventSourceInit?: Init
}

class TandemEventSourceError extends errore.createTaggedError({
	name: "TandemEventSourceError",
	message: "Could not read a poke payload",
}) {}

class MissingEventSourceError extends errore.createTaggedError({
	name: "MissingEventSourceError",
	message:
		"connectTandemEventSource needs an EventSource. This runtime has no global EventSource, so pass one as the EventSource option.",
}) {}

// EventSource.CLOSED, which a passed constructor need not define.
const closed = 2

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
 * Throws when no `EventSource` is passed and the runtime has none.
 */
export function connectTandemEventSource<
	Schema extends AnySchema = AnySchema,
	Init = { withCredentials?: boolean },
>({
	url,
	poke,
	schema,
	pullInterval = 60_000,
	reconnectDelay = 5_000,
	EventSource = (
		globalThis as { EventSource?: TandemEventSourceConstructor<Init> }
	).EventSource,
	eventSourceInit,
}: TandemEventSourceArgs<Schema, Init>): AsyncUnsubscribe {
	if (!EventSource) throw new MissingEventSourceError()
	const href = typeof url === "string" ? url : url.href
	let source: TandemEventSourceApi | undefined
	let reconnectTimer: ReturnType<typeof setTimeout> | undefined
	const onReady = () => void poke()
	const onPoke = (event: { data?: unknown }) => {
		const payload = readPayload(event.data, schema)
		if (payload instanceof Error) {
			// The pull still delivers the records; only the live update is lost.
			console.error(payload)
			void poke()
			return
		}
		void poke(payload)
	}
	const onError = () => {
		// EventSource retries dropped streams itself, but not failed responses.
		if (source?.readyState !== closed) return
		close()
		reconnectTimer = setTimeout(open, reconnectDelay)
	}
	const open = () => {
		reconnectTimer = undefined
		source = new EventSource(href, eventSourceInit)
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
