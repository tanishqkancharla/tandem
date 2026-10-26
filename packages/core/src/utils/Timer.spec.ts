import { afterEach, describe, expect, it, vi } from "vitest"
import { VisibilityAwareTimer } from "./Timer.js"

type Listener = () => void

function stubDocument(visibilityState: "visible" | "hidden") {
	const listeners = new Set<Listener>()
	const document = {
		visibilityState,
		addEventListener: (_type: string, listener: Listener) =>
			listeners.add(listener),
		removeEventListener: (_type: string, listener: Listener) =>
			listeners.delete(listener),
		hide() {
			document.visibilityState = "hidden"
			for (const listener of listeners) listener()
		},
		listeners,
	}
	vi.stubGlobal("document", document)
	return document
}

/** Posts a message, which fake timers do not hold. */
function nextTask() {
	return new Promise<void>((resolve) => {
		const { port1, port2 } = new MessageChannel()
		port1.onmessage = () => {
			port1.close()
			resolve()
		}
		port2.postMessage(undefined)
	})
}

async function settled(promise: Promise<void>) {
	let done = false
	void promise.then(() => (done = true))
	// Let posted messages and microtasks run without advancing fake timers.
	await nextTask()
	await nextTask()
	return done
}

describe("VisibilityAwareTimer", () => {
	afterEach(() => {
		vi.useRealTimers()
		vi.unstubAllGlobals()
	})

	it("waits its interval while the page is visible", async () => {
		vi.useFakeTimers()
		const document = stubDocument("visible")
		const tick = new VisibilityAwareTimer({ interval: 150 }).waitForNextTick()

		expect(await settled(tick)).toBe(false)
		vi.advanceTimersByTime(150)
		expect(await settled(tick)).toBe(true)
		// The visibility listener is removed once the tick resolves.
		expect(document.listeners.size).toBe(0)
	})

	it("does not wait on timers in a hidden page", async () => {
		vi.useFakeTimers()
		stubDocument("hidden")
		const tick = new VisibilityAwareTimer({ interval: 150 }).waitForNextTick()

		expect(await settled(tick)).toBe(true)
	})

	it("stops waiting on its timer when the page hides", async () => {
		vi.useFakeTimers()
		const document = stubDocument("visible")
		const tick = new VisibilityAwareTimer({ interval: 150 }).waitForNextTick()
		expect(await settled(tick)).toBe(false)

		document.hide()
		expect(await settled(tick)).toBe(true)
		expect(document.listeners.size).toBe(0)
	})

	it("waits its interval where there is no document", async () => {
		vi.useFakeTimers()
		const tick = new VisibilityAwareTimer({ interval: 150 }).waitForNextTick()

		expect(await settled(tick)).toBe(false)
		vi.advanceTimersByTime(150)
		expect(await settled(tick)).toBe(true)
	})
})
