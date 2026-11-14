import { connectTandemEventSource } from "@tanishqkancharla/tandem-core"
import { afterEach, expect, test, vi } from "vitest"

afterEach(() => {
	vi.unstubAllGlobals()
})

test("connectTandemEventSource asks for an EventSource where the runtime has none", () => {
	vi.stubGlobal("EventSource", undefined)

	expect(() =>
		connectTandemEventSource({ url: "/events", poke: async () => {} }),
	).toThrow("pass one as the EventSource option")
})
