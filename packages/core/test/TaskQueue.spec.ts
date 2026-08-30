import { describe, expect, it, vi } from "vitest"
import type { TimerApi } from "@tanishqkancharla/tandem-core"
import { TaskQueue } from "../src/utils/TaskQueue.js"

class ManualTimer implements TimerApi {
	readonly delays: { ms: number; resolve: () => void }[] = []

	delay(ms: number): Promise<void> {
		return new Promise((resolve) => {
			this.delays.push({ ms, resolve })
		})
	}

	resolveNextDelay() {
		const delay = this.delays.shift()
		expect(delay).toBeDefined()
		delay?.resolve()
	}
}

describe("TaskQueue", () => {
	it("coalesces duplicate queued tasks by name", async () => {
		const timer = new ManualTimer()
		const calls: string[] = []
		const queue = new TaskQueue(
			{
				push: async () => {
					calls.push("push")
				},
			},
			25,
			timer,
		)

		// Duplicate queued tasks share the same delayed batch promise
		const firstPush = queue.enqueue("push")
		const duplicatePush = queue.enqueue("push")

		expect(duplicatePush).toBe(firstPush)
		expect(timer.delays).toEqual([{ ms: 25, resolve: expect.any(Function) }])
		expect(calls).toEqual([])

		timer.resolveNextDelay()
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
			0,
			timer,
		)

		// Start the first push and hold it in-flight
		const firstPush = queue.enqueue("push")
		timer.resolveNextDelay()
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
				pull: async () => {
					calls.push("pull")
				},
			},
			0,
			timer,
		)

		// A pull queued behind an in-flight push waits for the push to finish
		const push = queue.enqueue("push")
		const pull = queue.enqueue("pull")
		timer.resolveNextDelay()

		await vi.waitFor(() => {
			expect(calls).toEqual(["push:start"])
		})

		gate.resolve()
		await Promise.all([push, pull])

		expect(calls).toEqual(["push:start", "push:end", "pull"])
	})
})
