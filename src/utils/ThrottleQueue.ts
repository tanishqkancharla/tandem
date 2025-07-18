import { Thenable } from "../types"

export class ThrottleQueue {
	private taskThenable: Thenable | undefined

	constructor(
		private readonly task: () => Promise<void>,
		private readonly onError: (error: unknown) => void,
		private readonly interval: number,
	) {}

	/**
	 * Returns a thenable when task finishes running. This should never throw.
	 */
	enqueue(): Thenable {
		if (this.taskThenable) return this.taskThenable

		const callbacks: Set<() => void> = new Set()

		setTimeout(() => {
			this.task()
				.then(() => {
					callbacks.forEach((callback) => callback())
					callbacks.clear()
				})
				.catch((error) => this.onError(error))

			// If you queue once the task has already started running, it should go into a
			// new thenable.
			this.taskThenable = undefined
		}, this.interval)

		const taskThenable: Thenable = {
			then: (callback) => {
				callbacks.add(callback)
				return taskThenable
			},
		}

		this.taskThenable = taskThenable
		return this.taskThenable
	}
}
