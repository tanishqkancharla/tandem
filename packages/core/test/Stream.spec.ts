import { describe, expect, test } from "vitest"
import { Stream } from "../src/utils/Stream.js"

describe("Stream", () => {
	test("subscribe receives appends until unsubscribed", () => {
		const stream = new Stream<number>()
		const received: number[] = []
		const unsubscribe = stream.subscribe((value) => received.push(value))

		// Appends notify the live subscriber
		stream.append(1)
		stream.append(2)
		expect(received).toEqual([1, 2])

		// After unsubscribing, further appends are ignored
		unsubscribe()
		stream.append(3)
		expect(received).toEqual([1, 2])
	})

	test("consume accepts optional options and stops when aborted", async () => {
		const stream = new Stream<number>()
		const abortController = new AbortController()
		const values = stream
			.map((value) => value * 2)
			.filter((value) => value > 2)
			.consume({ abortSignal: abortController.signal })

		// Mapped and filtered values are yielded to the consumer
		const first = values.next()
		stream.append(1)
		stream.append(2)
		await expect(first).resolves.toEqual({ done: false, value: 4 })

		// Aborting ends consumption and ignores later appends
		const finished = values.next()
		abortController.abort()
		await expect(finished).resolves.toEqual({ done: true, value: undefined })

		stream.append(3)
		await expect(values.next()).resolves.toEqual({
			done: true,
			value: undefined,
		})
	})

	test("consume works without options", async () => {
		const stream = new Stream<string>()
		const values = stream.consume()
		const first = values.next()
		stream.append("ready")

		await expect(first).resolves.toEqual({ done: false, value: "ready" })
		await values.return()
	})
})
