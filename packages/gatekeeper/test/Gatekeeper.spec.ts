import { Gatekeeper } from "@tanishqkancharla/gatekeeper"
import { describe, expect, test as base } from "vitest"

interface StoreApi {
	write(value: number): Promise<number>
}

class Store implements StoreApi {
	private value = 0

	read() {
		return this.value
	}

	write(value: number) {
		this.value = value
		return Promise.resolve(value)
	}
}

class Server {
	constructor(private readonly store: StoreApi) {}

	save(value: number) {
		return this.store.write(value)
	}
}

class Client {
	private visibleValue = 0
	private confirmedValue = 0
	private previousSave: Promise<void> = Promise.resolve()

	constructor(private readonly server: Pick<Server, "save">) {}

	read() {
		return this.visibleValue
	}

	confirmed() {
		return this.confirmedValue
	}

	save(value: number) {
		this.visibleValue = value
		const pending = this.previousSave
			.then(() => this.server.save(value))
			.then((saved) => {
				this.confirmedValue = saved
				return saved
			})
		// The public promise preserves the result; this private chain only serializes
		// later saves and must continue after either outcome.
		this.previousSave = pending.then(
			() => undefined,
			() => undefined,
		)
		return pending
	}
}

class ManualTimer {
	private nextTick?: PromiseWithResolvers<void>

	waitForNextTick(): Promise<void> {
		this.nextTick = Promise.withResolvers<void>()
		return this.nextTick.promise
	}

	isWaiting(): boolean {
		return this.nextTick !== undefined
	}

	async fire(): Promise<void> {
		const nextTick = this.nextTick
		this.nextTick = undefined
		nextTick?.resolve()
		await Promise.resolve()
	}
}

class TimerClient {
	constructor(
		private readonly timer: Pick<ManualTimer, "waitForNextTick">,
		private readonly server: Pick<Server, "save">,
	) {}

	async saveAfterNextTick(value: number): Promise<number> {
		await this.timer.waitForNextTick()
		return await this.server.save(value)
	}
}

function createHarness() {
	return new Gatekeeper()
		.add("store", () => new Store())
		.add("server", ({ store }) => new Server(store))
		.add("client1", ({ server }) => new Client(server))
		.add("client2", ({ server }) => new Client(server))
		.build()
}

function createTimerHarness(gates: { enter: boolean; exit: boolean }) {
	return new Gatekeeper()
		.add("store", () => new Store())
		.add("server", ({ store }) => new Server(store))
		.add("client1Timer", () => new ManualTimer(), { gates })
		.add(
			"client1",
			({ server, client1Timer }) => new TimerClient(client1Timer, server),
		)
		.build()
}

type TestHarness = ReturnType<typeof createHarness>

const test = base.extend<{ harness: TestHarness }>({
	harness: async ({}, use) => {
		await using harness = createHarness()
		await harness.activateGates()
		await use(harness)
	},
})

/** The services are real and stateful; only communication timing and failures are controlled. */
describe("Gatekeeper", () => {
	test("holds the first handoff before the server processes it", async ({
		harness,
	}) => {
		const call = await harness.client1.save(10)

		call.assertSentBy("client1").assertWaitingFor("server")
		expect(harness.client1.read()).toBe(10)
		expect(harness.client1.confirmed()).toBe(0)
		expect(harness.store.read()).toBe(0)
	})

	test("advances the request to the server's next handoff", async ({
		harness,
	}) => {
		const call = await harness.client1.save(10)

		await call.continueTo("server")

		call.assertSentBy("server").assertWaitingFor("store")
		expect(harness.store.read()).toBe(0)
	})

	test("processes the store write before returning its result", async ({
		harness,
	}) => {
		const call = await harness.client1.save(10)
		await call.continueTo("server")

		await call.continueTo("store")

		call.assertSentBy("store").assertWaitingFor("server")
		expect(harness.store.read()).toBe(10)
		expect(harness.client1.confirmed()).toBe(0)
	})

	test("returns through the server before delivering to the client", async ({
		harness,
	}) => {
		const call = await harness.client1.save(10)
		await call.continueTo("server")
		await call.continueTo("store")

		await call.continueTo("server")

		call.assertSentBy("server").assertWaitingFor("client1")
		expect(harness.client1.confirmed()).toBe(0)
	})

	test("delivers the result to the original client", async ({ harness }) => {
		const call = await harness.client1.save(10)
		await call.continueTo("server")
		await call.continueTo("store")
		await call.continueTo("server")

		await call.continueTo("client1")

		call.assertCompleted()
		expect(await call.result).toBe(10)
		expect(harness.client1.confirmed()).toBe(10)
	})

	test("can allow one call to run through all of its gates", async ({
		harness,
	}) => {
		const call = await harness.client1.save(10)

		await call.continueToCompletion()

		call.assertCompleted()
		expect(await call.result).toBe(10)
		expect(harness.client1.confirmed()).toBe(10)
		expect(harness.store.read()).toBe(10)
	})

	test("controls either client without releasing the other client's call", async ({
		harness,
	}) => {
		const first = await harness.client1.save(10)
		const second = await harness.client2.save(20)

		await second.continueToCompletion()

		first.assertSentBy("client1").assertWaitingFor("server")
		second.assertCompleted()
		expect(await second.result).toBe(20)
		expect(harness.client2.confirmed()).toBe(20)
		expect(harness.client1.confirmed()).toBe(0)
		expect(harness.store.read()).toBe(20)
	})

	test("fails before the receiving service processes a handoff", async ({
		harness,
	}) => {
		const call = await harness.client1.save(10)
		const failure = new Error("Server is unreachable")

		await call.fail(failure)

		call.assertCompleted()
		await expect(call.result).rejects.toBe(failure)
		expect(harness.store.read()).toBe(0)
	})

	test("fails a processed result before it reaches the calling service", async ({
		harness,
	}) => {
		const call = await harness.client1.save(10)
		await call.continueTo("server")
		await call.continueTo("store")
		const failure = new Error("Store response was lost")

		await call.fail(failure)

		call.assertSentBy("server").assertWaitingFor("client1")
		expect(harness.store.read()).toBe(10)
	})

	test("delivers a failed result to the original client", async ({
		harness,
	}) => {
		const call = await harness.client1.save(10)
		await call.continueTo("server")
		await call.continueTo("store")
		const failure = new Error("Store response was lost")
		await call.fail(failure)

		await call.continueTo("client1")

		call.assertCompleted()
		await expect(call.result).rejects.toBe(failure)
		expect(harness.store.read()).toBe(10)
	})

	test("waits for a queued call to reach its own first handoff", async ({
		harness,
	}) => {
		const first = await harness.client1.save(10)
		const secondReady = harness.client1.save(20)

		await first.continueToCompletion()
		const second = await secondReady

		second.assertSentBy("client1").assertWaitingFor("server")
		expect(harness.client1.read()).toBe(20)
		expect(harness.client1.confirmed()).toBe(10)
	})

	test("returns a settled call handle when gates are deactivated", async ({
		harness,
	}) => {
		await harness.deactivateGates()

		const call = await harness.client1.save(10)

		call.assertCompleted()
		expect(await call.result).toBe(10)
		expect(harness.client1.confirmed()).toBe(10)
		expect(harness.store.read()).toBe(10)
	})

	test("releases held calls and waits for them when gates are deactivated", async ({
		harness,
	}) => {
		const call = await harness.client1.save(10)

		await harness.deactivateGatesAndSettle()

		call.assertCompleted()
		expect(await call.result).toBe(10)
		expect(harness.client1.confirmed()).toBe(10)
		expect(harness.store.read()).toBe(10)
	})

	test("disposal rejects a held call without processing it", async () => {
		const store = new Store()
		const harness = new Gatekeeper()
			.add("store", () => store)
			.add("server", ({ store }) => new Server(store))
			.add("client1", ({ server }) => new Client(server))
			.build()
		await harness.activateGates()
		const call = await harness.client1.save(10)
		const result = expect(call.result).rejects.toThrow(/disposed/i)

		await harness[Symbol.asyncDispose]()

		await result
		expect(store.read()).toBe(0)
		expect(harness.store.read).toThrow(/disposed/i)
	})

	test("holds a timer wait before entry when its enter gate is enabled", async () => {
		await using harness = createTimerHarness({ enter: true, exit: false })
		await harness.activateGates()

		const call = await harness.client1.saveAfterNextTick(10)

		call.assertSentBy("client1").assertWaitingFor("client1Timer")
		expect(harness.client1Timer.isWaiting()).toBe(false)
		expect(harness.store.read()).toBe(0)
	})

	test("lets a timer register its wait when its enter gate is disabled", async () => {
		await using harness = createTimerHarness({ enter: false, exit: false })
		await harness.activateGates()

		const call = await harness.client1.saveAfterNextTick(10)

		call.assertSentBy("client1").assertWaitingFor("client1Timer")
		expect(harness.client1Timer.isWaiting()).toBe(true)
		expect(harness.store.read()).toBe(0)
	})

	test("continues directly to the next service when the timer exit gate is disabled", async () => {
		await using harness = createTimerHarness({ enter: false, exit: false })
		await harness.activateGates()
		const call = await harness.client1.saveAfterNextTick(10)

		await harness.client1Timer.fire()

		call.assertSentBy("client1").assertWaitingFor("server")
		expect(harness.store.read()).toBe(0)
	})

	test("holds a fired timer response when its exit gate is enabled", async () => {
		await using harness = createTimerHarness({ enter: false, exit: true })
		await harness.activateGates()
		const call = await harness.client1.saveAfterNextTick(10)

		await harness.client1Timer.fire()

		call.assertSentBy("client1Timer").assertWaitingFor("client1")
		expect(harness.store.read()).toBe(0)
	})

	test("rejects overlapping controls without releasing the call", async () => {
		await using harness = createTimerHarness({ enter: true, exit: false })
		await harness.activateGates()
		const call = await harness.client1.saveAfterNextTick(10)

		const progressing = call.continueTo("client1Timer")
		await expect(call.continueToCompletion()).rejects.toThrow(
			/another control is in progress/,
		)
		await harness.client1Timer.fire()
		await progressing

		call.assertSentBy("client1").assertWaitingFor("server")
		expect(harness.store.read()).toBe(0)
	})

	test("returns a settled call handle without a service handoff", async () => {
		await using harness = new Gatekeeper()
			.add("calculator", () => ({
				double: (value: number) => Promise.resolve(value * 2),
			}))
			.build()
		await harness.activateGates()

		const call = await harness.calculator.double(5)

		call.assertCompleted()
		expect(await call.result).toBe(10)
	})

	test("preserves an application rejection before any service handoff", async () => {
		const failure = new Error("Calculation failed")
		await using harness = new Gatekeeper()
			.add("calculator", () => ({
				double: (_value: number) => Promise.reject(failure),
			}))
			.build()
		await harness.activateGates()

		const call = await harness.calculator.double(5)

		call.assertCompleted()
		await expect(call.result).rejects.toBe(failure)
	})

	test("rejects synchronous calls between gated services", async () => {
		await using harness = new Gatekeeper()
			.add("store", () => ({ read: () => 10 }))
			.add("client", ({ store }) => ({
				read: () => Promise.resolve(store.read()),
			}))
			.build()
		await harness.activateGates()
		const call = await harness.client.read()

		await expect(call.continueTo("store")).rejects.toThrow(
			/calls between services must return promises/,
		)

		call.assertCompleted()
		await expect(call.result).rejects.toThrow(
			/calls between services must return promises/,
		)
	})
})
