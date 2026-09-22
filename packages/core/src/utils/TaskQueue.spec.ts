import { describe, expect, it, vi } from "vitest"
import { TaskQueue } from "./TaskQueue.js"
import type { TimerApi } from "./Timer.js"

class ManualTimer implements TimerApi {
	readonly ticks: { resolve: () => void }[] = []

	waitForNextTick(): Promise<void> {
		return new Promise((resolve) => {
			this.ticks.push({ resolve })
		})
	}

	resolveNextTick() {
		const tick = this.ticks.shift()
		expect(tick).toBeDefined()
		tick?.resolve()
	}
}

describe("TaskQueue", () => {
	it("coalesces duplicate queued tasks by name", async () => {
		const timer = new ManualTimer()
		const calls: string[] = []
		const queue = new TaskQueue(
			{
				push: () => {
					calls.push("push")
					return Promise.resolve()
				},
			},
			timer,
		)

		// Duplicate queued tasks share the same delayed batch promise
		const firstPush = queue.enqueue("push")
		const duplicatePush = queue.enqueue("push")

		expect(duplicatePush).toBe(firstPush)
		expect(timer.ticks).toEqual([{ resolve: expect.any(Function) }])
		expect(calls).toEqual([])

		timer.resolveNextTick()
		await firstPush

		expect(calls).toEqual(["push"])
	})

	it("schedules one follow-up run for duplicate tasks requested in-flight", async () => {
		const timer = new ManualTimer()
		const gate = Promise.withResolvers<void>()
		const calls: string[] = []
		const queue = new TaskQueue(
			{
				push: async () => {
					calls.push("push")
					if (calls.length === 1) {
						await gate.promise
					}
				},
			},
			timer,
		)

		// Start the first push and hold it in-flight
		const firstPush = queue.enqueue("push")
		timer.resolveNextTick()
		await vi.waitFor(() => {
			expect(calls).toEqual(["push"])
		})

		// Duplicate pushes requested during the first run share one follow-up run
		const followUpPush = queue.enqueue("push")
		const duplicateFollowUpPush = queue.enqueue("push")

		expect(followUpPush).not.toBe(firstPush)
		expect(duplicateFollowUpPush).toBe(followUpPush)

		gate.resolve()
		await Promise.all([firstPush, followUpPush])

		expect(calls).toEqual(["push", "push"])
	})

	it("runs different task names sequentially", async () => {
		const timer = new ManualTimer()
		const gate = Promise.withResolvers<void>()
		const calls: string[] = []
		const queue = new TaskQueue(
			{
				push: async () => {
					calls.push("push:start")
					await gate.promise
					calls.push("push:end")
				},
				pull: () => {
					calls.push("pull")
					return Promise.resolve()
				},
			},
			timer,
		)

		// A pull queued behind an in-flight push waits for the push to finish
		const push = queue.enqueue("push")
		const pull = queue.enqueue("pull")
		timer.resolveNextTick()

		await vi.waitFor(() => {
			expect(calls).toEqual(["push:start"])
		})

		gate.resolve()
		await Promise.all([push, pull])

		expect(calls).toEqual(["push:start", "push:end", "pull"])
	})
})
