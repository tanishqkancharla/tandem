import type { TimerApi } from "../types"

export class ThrottleQueue {
	private taskPromise: Promise<void> | undefined

	constructor(
		private readonly task: () => Promise<void>,
		private readonly interval: number,
		private readonly timer: TimerApi,
	) {}

	/**
	 * Returns a shared promise for the currently queued batch.
	 */
	enqueue(): Promise<void> {
		if (this.taskPromise) return this.taskPromise

		this.taskPromise = this.timer.delay(this.interval).then((): Promise<void> => {
			const taskPromise = this.task()

			// If you queue once the task has already started running, it should go into a
			// new batch.
			this.taskPromise = undefined

			return taskPromise
		})

		return this.taskPromise
	}

	/**
	 * If a batch is queued, immediately execute it without waiting for the
	 * throttle delay. No-op when nothing is pending.
	 */
	async flush(): Promise<void> {
		if (this.taskPromise) {
			this.taskPromise = undefined
			await this.task()
		}
	}
}
