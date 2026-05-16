import type { TimerApi } from "@tandem/types"

type TaskItem<TaskName extends string> = {
	name: TaskName
	promise: Promise<void>
	resolve: () => void
	reject: (error: unknown) => void
}

export class TaskQueue<TaskName extends string> {
	private readonly queue: TaskItem<TaskName>[] = []
	private readonly queuedItems = new Map<TaskName, TaskItem<TaskName>>()
	private drainPromise?: Promise<void>

	constructor(
		private readonly tasks: Record<TaskName, () => Promise<void>>,
		private readonly interval: number,
		private readonly timer: TimerApi,
	) {}

	enqueue(name: TaskName): Promise<void> {
		const queuedItem = this.queuedItems.get(name)
		if (queuedItem) return queuedItem.promise

		const item = this.createItem(name)
		this.queuedItems.set(name, item)
		this.queue.push(item)

		this.drainPromise ??= this.drain()

		return item.promise
	}

	private createItem(name: TaskName): TaskItem<TaskName> {
		let resolve!: () => void
		let reject!: (error: unknown) => void
		const promise = new Promise<void>((resolvePromise, rejectPromise) => {
			resolve = resolvePromise
			reject = rejectPromise
		})

		return { name, promise, resolve, reject }
	}

	private async drain() {
		try {
			await this.timer.delay(this.interval)

			while (this.queue.length > 0) {
				const item = this.queue.shift()
				if (!item) continue

				this.queuedItems.delete(item.name)

				try {
					await this.tasks[item.name]()
					item.resolve()
				} catch (error) {
					item.reject(error)
				}
			}
		} finally {
			this.drainPromise = undefined

			if (this.queue.length > 0) {
				this.drainPromise = this.drain()
			}
		}
	}
}
