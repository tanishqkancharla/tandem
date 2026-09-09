import { describe, expect, test } from "vitest"
import {
	CallAlreadySettledError,
	DuplicateServiceError,
	Gatekeeper,
} from "../src/index"

class Server {
	callCount = 0

	async addOne(value: number) {
		this.callCount += 1
		return value + 1
	}
}

class Client {
	constructor(private server: Server) {}

	async addOneThroughServer(value: number) {
		return this.server.addOne(value)
	}

	async addBoth() {
		const first = this.server.addOne(1)
		const second = this.server.addOne(10)
		return (await first) + (await second)
	}
}

class DeferredClient {
	constructor(private server: Server) {}

	async addOneThroughServer(value: number) {
		await Promise.resolve()
		return this.server.addOne(value)
	}
}

function createHarness(server = new Server()) {
	return {
		server,
		harness: new Gatekeeper()
			.add("server", () => server)
			.add("client", ({ server }) => new Client(server))
			.build(),
	}
}

describe("Gatekeeper", () => {
	test("allow() runs a service method and returns its result", async () => {
		const { harness, server } = createHarness()

		const addOneCall = await harness.server.addOne(1)

		expect(addOneCall.service).toBe("server")
		expect(addOneCall.method).toBe("addOne")
		expect(addOneCall.args).toEqual([1])
		expect(await addOneCall.allow()).toBe(2)
		expect(server.callCount).toBe(1)
	})

	test("mockReturnValue() skips the implementation", async () => {
		const { harness, server } = createHarness()
		const addOneCall = await harness.server.addOne(1)

		expect(await addOneCall.mockReturnValue(99)).toBe(99)
		expect(server.callCount).toBe(0)
	})

	test("fail() rejects the call with the given error", async () => {
		const { harness } = createHarness()
		const addOneCall = await harness.server.addOne(1)
		const error = new Error("boom")

		await expect(addOneCall.fail(error)).rejects.toBe(error)
	})

	test("inter-service calls pause until the test allows them", async () => {
		const { harness } = createHarness()
		const resultPromise = (await harness.client.addOneThroughServer(1)).allow()
		const serverCall = await harness.nextCall()

		expect(serverCall.service).toBe("server")
		expect(serverCall.method).toBe("addOne")
		expect(serverCall.args).toEqual([1])

		await serverCall.allow()
		expect(await resultPromise).toBe(2)
	})

	test("inter-service calls can be mocked", async () => {
		const { harness, server } = createHarness()
		const resultPromise = (await harness.client.addOneThroughServer(1)).allow()
		const serverCall = await harness.nextCall()

		expect(await serverCall.mockReturnValue(99)).toBe(99)
		expect(await resultPromise).toBe(99)
		expect(server.callCount).toBe(0)
	})

	test("inter-service failures propagate to the caller", async () => {
		const { harness } = createHarness()
		const resultPromise = (await harness.client.addOneThroughServer(1)).allow()
		const serverCall = await harness.nextCall()
		const error = new Error("server down")

		await expect(serverCall.fail(error)).rejects.toBe(error)
		await expect(resultPromise).rejects.toBe(error)
	})

	test("nextCall() yields pending inter-service calls in order", async () => {
		const { harness } = createHarness()
		const resultPromise = (await harness.client.addBoth()).allow()

		const firstCall = await harness.nextCall()
		expect(firstCall.args).toEqual([1])
		await firstCall.allow()

		const secondCall = await harness.nextCall()
		expect(secondCall.args).toEqual([10])
		await secondCall.allow()

		expect(await resultPromise).toBe(12)
	})

	test("nextCall() waits until a nested call is made", async () => {
		const server = new Server()
		const harness = new Gatekeeper()
			.add("server", () => server)
			.add("client", ({ server }) => new DeferredClient(server))
			.build()

		const resultPromise = (await harness.client.addOneThroughServer(1)).allow()
		const serverCall = await harness.nextCall()

		await serverCall.allow()
		expect(await resultPromise).toBe(2)
	})

	test("settling a call twice throws CallAlreadySettledError", async () => {
		const { harness } = createHarness()
		const addOneCall = await harness.server.addOne(1)

		await addOneCall.allow()
		expect(() => {
			void addOneCall.mockReturnValue(0)
		}).toThrow(CallAlreadySettledError)
	})

	test("add() rejects duplicate service names", () => {
		expect(() => {
			new Gatekeeper()
				.add("server", () => new Server())
				.add("server", () => new Server())
		}).toThrow(DuplicateServiceError)
	})
})
