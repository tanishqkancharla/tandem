import type { TimerApi } from "./Timer"

type TaskItem = {
	promise: Promise<void>
}

type TaskBatch = {
	delay: Promise<void>
	tail: Promise<void>
	pending: number
}

export class TaskQueue<TaskName extends string> {
	private readonly queuedItems = new Map<TaskName, TaskItem>()
	private batch?: TaskBatch

	constructor(
		private readonly tasks: Record<TaskName, () => Promise<void>>,
		private readonly timer: TimerApi,
	) {}

	enqueue(name: TaskName): Promise<void> {
		const queuedItem = this.queuedItems.get(name)
		if (queuedItem) return queuedItem.promise

		const batch = this.batch ?? {
			delay: this.timer.waitForNextTick(),
			tail: Promise.resolve(),
			pending: 0,
		}
		this.batch = batch
		batch.pending += 1

		const promise = Promise.all([batch.delay, batch.tail]).then(async () => {
			this.queuedItems.delete(name)
			await this.tasks[name]()
		})
		const item = { promise }
		this.queuedItems.set(name, item)
		batch.tail = promise.then(
			() => undefined,
			() => undefined,
		)
		const settled = () => {
			batch.pending -= 1
			if (batch.pending === 0 && this.batch === batch) this.batch = undefined
		}
		void promise.then(settled, settled)

		return promise
	}
}
