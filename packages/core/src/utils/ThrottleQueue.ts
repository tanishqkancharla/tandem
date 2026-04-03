export class ThrottleQueue {
	private taskPromise: Promise<void> | undefined

	constructor(
		private readonly task: () => Promise<void>,
		private readonly interval: number,
	) {}

	/**
	 * Returns a shared promise for the currently queued batch.
	 */
	enqueue(): Promise<void> {
		if (this.taskPromise) return this.taskPromise

		this.taskPromise = new Promise<void>((resolve, reject) => {
			setTimeout(() => {
				const taskPromise = this.task()

				// If you queue once the task has already started running, it should go into a
				// new batch.
				this.taskPromise = undefined

				taskPromise.then(resolve).catch(reject)
			}, this.interval)
		})

		return this.taskPromise
	}
}
