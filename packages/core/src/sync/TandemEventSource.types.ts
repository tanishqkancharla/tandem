import { connectTandemEventSource } from "@tanishqkancharla/tandem-core"

declare const poke: Parameters<typeof connectTandemEventSource>[0]["poke"]

// The browser's EventSource fits the option, with its own init options.
connectTandemEventSource({
	url: new URL("https://example.com/events"),
	poke,
	EventSource: globalThis.EventSource,
	eventSourceInit: { withCredentials: true },
})

class HeaderEventSource {
	readonly readyState = 0
	constructor(_url: string, _init?: { headers: Record<string, string> }) {}
	addEventListener(
		_type: string,
		_listener: (event: { data?: unknown }) => void,
	) {}
	removeEventListener(
		_type: string,
		_listener: (event: { data?: unknown }) => void,
	) {}
	close() {}
}

// Init options follow the passed constructor.
connectTandemEventSource({
	url: "/events",
	poke,
	EventSource: HeaderEventSource,
	eventSourceInit: { headers: { authorization: "Bearer token" } },
})

connectTandemEventSource({
	url: "/events",
	poke,
	EventSource: HeaderEventSource,
	// @ts-expect-error The init options must match the passed constructor.
	eventSourceInit: { withCredentials: true },
})
