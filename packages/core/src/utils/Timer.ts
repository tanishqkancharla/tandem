import { visibilityDocument } from "../platform.js"

export type TimerApi = {
	waitForNextTick: () => Promise<void>
}

export class Timer implements TimerApi {
	private readonly interval: number

	constructor({ interval }: { interval: number }) {
		this.interval = interval
	}

	waitForNextTick(): Promise<void> {
		return new Promise((resolve) => setTimeout(resolve, this.interval))
	}
}

/**
 * Waits for the next task by posting a message. Browsers delay timers in
 * hidden tabs by a second or more, but deliver messages promptly.
 */
function nextTask(): Promise<void> {
	return new Promise((resolve) => {
		const { port1, port2 } = new MessageChannel()
		port1.addEventListener("message", () => {
			port1.close()
			resolve()
		})
		port1.start()
		port2.postMessage(undefined)
	})
}

/**
 * Waits `interval` ms while the page is visible. In a hidden page, or once the
 * page hides, waits only for the next task instead of a throttled timer.
 */
export class VisibilityAwareTimer implements TimerApi {
	private readonly interval: number

	constructor({ interval }: { interval: number }) {
		this.interval = interval
	}

	waitForNextTick(): Promise<void> {
		const document = visibilityDocument()
		if (document?.visibilityState === "hidden") return nextTask()
		return new Promise((resolve) => {
			const done = () => {
				clearTimeout(timeout)
				document?.removeEventListener("visibilitychange", onVisibilityChange)
				resolve()
			}
			const onVisibilityChange = () => {
				if (document?.visibilityState === "hidden") void nextTask().then(done)
			}
			const timeout = setTimeout(done, this.interval)
			document?.addEventListener("visibilitychange", onVisibilityChange)
		})
	}
}
