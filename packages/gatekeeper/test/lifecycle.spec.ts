import { Gatekeeper, GatekeeperError } from "@tanishqkancharla/gatekeeper"
import { expect, test } from "vitest"
import { Client, Server } from "./services"

test("preserves an application's rejection before any outgoing call", async () => {
	const failure = new Error("Cannot prepare the request")
	await using harness = new Gatekeeper()
		.add("client", () => ({ save: () => Promise.reject(failure) }))
		.build()

	await expect(harness.client.save()).rejects.toBe(failure)
	await expect(harness.client.save().hold()).rejects.toBe(failure)
})

test("disposal abandons requests and rejects queued hold waiters", async () => {
	const receiver = new Server()
	await using harness = new Gatekeeper()
		.add("server", () => receiver)
		.add("client", ({ server }) => new Client(server))
		.build()
	const first = await harness.client.write(10).hold()
	const secondReady = harness.client.write(20).hold()
	const rejected = expect(secondReady).rejects.toThrow(/disposed/i)

	// Teardown does not deliver either write or wait for the client's queue.
	await harness[Symbol.asyncDispose]()
	await rejected
	await expect(first.continue()).rejects.toThrow(/disposed/i)
	expect(receiver.read()).toBe(0)
})

test("disposal leaves completed receiver effects intact and keeps services caller-owned", async () => {
	const receiver = new Server()
	await using harness = new Gatekeeper()
		.add("server", () => receiver)
		.add("client", ({ server }) => new Client(server))
		.build()
	const call = await harness.client.write(10).hold()
	await call.continueUntil({ afterProcessedBy: harness.server })

	await harness[Symbol.asyncDispose]()
	await expect(call.fail(new Error("Too late"))).rejects.toThrow(/disposed/i)
	expect(receiver.read()).toBe(10)
	expect(await receiver.store(20)).toBe(20)
	expect(() => harness.server.read()).toThrow(/disposed/i)
})

test("rejects overlapping controls without disrupting the first progression", async () => {
	await using harness = new Gatekeeper()
		.add("server", () => new Server())
		.add("client", ({ server }) => new Client(server))
		.build()
	const call = await harness.client.write(10).hold()
	const reaching = call.continueUntil({ afterProcessedBy: harness.server })

	await expect(call.continue()).rejects.toThrow(/control is in progress/i)
	await reaching
	expect(harness.server.read()).toBe(10)
	expect(await call.continue()).toBe(10)
})

test("rejects a boundary from another harness without advancing the call", async () => {
	const builder = new Gatekeeper()
		.add("server", () => new Server())
		.add("client", ({ server }) => new Client(server))
	await using first = builder.build()
	await using second = builder.build()
	const call = await first.client.write(10).hold()

	await expect(
		call.continueUntil({ beforeProcessedBy: second.server }),
	).rejects.toThrow(/belong to this harness/i)
	expect(first.server.read()).toBe(0)
	expect(await call.continue()).toBe(10)
	expect(second.server.read()).toBe(0)
})

test("rejects holding an operation twice while preserving its first handle", async () => {
	await using harness = new Gatekeeper()
		.add("server", () => new Server())
		.add("client", ({ server }) => new Client(server))
		.build()
	const operation = harness.client.write(10)
	const call = await operation.hold()

	await expect(operation.hold()).rejects.toThrow(/already started or held/i)
	expect(await call.continue()).toBe(10)
})

test("normal consumption claims an operation and repeated awaits reuse its result", async () => {
	await using harness = new Gatekeeper()
		.add("server", () => new Server())
		.add("client", ({ server }) => new Client(server))
		.build()
	const operation = harness.client.write(10)
	const result = operation.then((value) => value)

	await expect(operation.hold()).rejects.toThrow(/already started or held/i)
	expect(await result).toBe(10)
	await harness.server.store(20)
	expect(await operation).toBe(10)
	expect(harness.server.read()).toBe(20)
})

// await using performs this test's asynchronous teardown.
// oxlint-disable-next-line eslint/require-await
test("preserves public properties and private-field method receivers", async () => {
	class Settings {
		#value = 1
		get value() {
			return this.#value
		}
		set value(value: number) {
			this.#value = value
		}
		read() {
			return this.#value
		}
	}
	await using harness = new Gatekeeper()
		.add("settings", () => new Settings())
		.build()

	harness.settings.value = 2
	expect(harness.settings.value).toBe(2)
	expect(harness.settings.read()).toBe(2)
	expect("value" in harness.settings).toBe(true)
})

test("reports synchronous calls between services as unsupported", async () => {
	await using harness = new Gatekeeper()
		.add("server", () => new Server())
		.add("client", ({ server }) => ({
			read: () => Promise.resolve(server.read()),
		}))
		.build()

	await expect(harness.client.read()).rejects.toThrow(/must return promises/i)
})

test("preserves a concurrent request failure while another request is still running", async () => {
	const failure = new Error("Request rejected")
	const pending = Promise.withResolvers<number>()
	await using harness = new Gatekeeper()
		.add("server", () => ({
			reject: () => Promise.reject(failure),
			wait: () => pending.promise,
		}))
		.add("client", ({ server }) => ({
			run: () => Promise.all([server.reject(), server.wait()]),
		}))
		.build()

	await expect(harness.client.run()).rejects.toBe(failure)
	pending.resolve(10)
})

test("preserves a race's result and lets the losing request finish normally", async () => {
	const pending = Promise.withResolvers<number>()
	const finished = Promise.withResolvers<void>()
	const receiver = new Server()
	await using harness = new Gatekeeper()
		.add("server", () => receiver)
		.add("worker", ({ server }) => ({
			fast: () => Promise.resolve(10),
			slow: async () => {
				const value = await pending.promise
				await server.store(value)
				finished.resolve()
				return value
			},
		}))
		.add("client", ({ worker }) => ({
			run: () => Promise.race([worker.fast(), worker.slow()]),
		}))
		.build()

	expect(await harness.client.run()).toBe(10)
	pending.resolve(20)
	await finished.promise
	expect(receiver.read()).toBe(20)
})

test("keeps remaining requests gated when a held operation finishes locally", async () => {
	const receiver = new Server()
	const local = Promise.withResolvers<number>()
	let result: Promise<number | Error> = Promise.resolve(0)
	await using harness = new Gatekeeper()
		.add("server", () => receiver)
		.add("client", ({ server }) => ({
			run: () => {
				result = Promise.race([server.store(10), local.promise])
				return result
			},
			finishLocally: () => {
				local.resolve(20)
				return result
			},
		}))
		.build()
	const call = await harness.client.run().hold()

	expect(await harness.client.finishLocally()).toBe(20)
	await expect(call.continue()).rejects.toThrow(/completed/i)
	expect(receiver.read()).toBe(0)
	await harness[Symbol.asyncDispose]()
	expect(receiver.read()).toBe(0)
})

test("reports a synchronous method that launches outgoing work without returning its promise", async () => {
	const receiver = new Server()
	const rejected = Promise.withResolvers<unknown>()
	await using harness = new Gatekeeper()
		.add("server", () => receiver)
		.add("client", ({ server }) => ({
			enqueue: () => {
				void server.store(10).catch(rejected.resolve)
			},
		}))
		.build()

	expect(() => harness.client.enqueue()).toThrow(/must return a promise/i)
	expect(await rejected.promise).toBeInstanceOf(GatekeeperError)
	expect(receiver.read()).toBe(0)
})

test("exposes descriptive control errors separately from application errors", async () => {
	await using harness = new Gatekeeper()
		.add("server", () => new Server())
		.build()
	await expect(harness.server.fetch().hold()).rejects.toBeInstanceOf(
		GatekeeperError,
	)
})
