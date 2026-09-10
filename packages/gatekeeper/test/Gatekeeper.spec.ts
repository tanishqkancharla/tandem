import { Gatekeeper } from "@tanishqkancharla/gatekeeper"
import { describe, expect } from "vitest"
import { test } from "./fixtures"
import {
	Client,
	DeliveryFailed,
	Forwarder,
	InvalidValue,
	PreparingClient,
	Server,
} from "./services"

describe("Gatekeeper contract (runtime implementation pending)", () => {
	test("ordinary calls await their real results without enabling gates", async ({
		client1,
		client2,
		server,
	}) => {
		expect(await client1.write(10)).toBe(10)
		expect(client1.isSaving()).toBe(false)
		expect(server.read()).toBe(10)

		expect(await client2.refresh()).toBe(10)
		expect(client2.read()).toBe(10)
	})

	test("separates local work, server processing, and response delivery", async ({
		client1,
		server,
	}) => {
		// Local work happens while the outgoing event remains held.
		const call = await client1.write(10).hold()
		expect(client1.read()).toBe(10)
		expect(client1.isSaving()).toBe(true)
		expect(server.read()).toBe(0)

		// Reaching the server's input boundary does not process the event.
		await call.continueUntil({ beforeProcessedBy: server })
		expect(server.read()).toBe(0)

		// Processing changes the server, but the client still awaits its response.
		await call.continueUntil({ afterProcessedBy: server })
		expect(server.read()).toBe(10)
		expect(client1.isSaving()).toBe(true)

		// Completing the original call delivers the response to the client.
		expect(await call.continue()).toBe(10)
		expect(client1.isSaving()).toBe(false)
	})

	test("lets the server process two held calls in reverse order", async ({
		client1,
		client2,
		server,
	}) => {
		const first = await client1.write(10).hold()
		const second = await client2.write(20).hold()

		// Client2's event reaches the server first; Client1's stays held.
		await second.continueUntil({ afterProcessedBy: server })
		expect(server.read()).toBe(20)
		expect(client1.isSaving()).toBe(true)
		expect(client2.isSaving()).toBe(true)

		// Client1's event arrives later and becomes the final stored value.
		await first.continueUntil({ afterProcessedBy: server })
		expect(server.read()).toBe(10)
		expect(await second.continue()).toBe(20)
		expect(await first.continue()).toBe(10)

		// Ordinary reads expose the final state to both clients.
		await client1.refresh()
		await client2.refresh()
		expect(client1.read()).toBe(10)
		expect(client2.read()).toBe(10)
	})

	test("holds one operation without gating unrelated ordinary calls", async ({
		client1,
		client2,
		server,
	}) => {
		const held = await client1.write(10).hold()

		expect(await client2.write(20)).toBe(20)
		expect(server.read()).toBe(20)
		expect(client2.isSaving()).toBe(false)
		expect(client1.isSaving()).toBe(true)

		expect(await held.continue()).toBe(10)
		expect(server.read()).toBe(10)
	})

	test("delivers the already-computed response even after server state changes", async ({
		client1,
		client2,
		server,
	}) => {
		await client1.write(10)
		const read = await client2.refresh().hold()
		await read.continueUntil({ afterProcessedBy: server })
		expect(client2.read()).toBe(0)

		// Another operation changes the server while the first response is held.
		await client1.write(20)
		expect(server.read()).toBe(20)

		// Delivery uses the old result rather than executing the request again.
		expect(await read.continue()).toBe(10)
		expect(client2.read()).toBe(10)
		expect(await client2.refresh()).toBe(20)
	})

	test("allows a local edit between response creation and response delivery", async ({
		client1,
		client2,
		server,
	}) => {
		await client2.write(10)
		const read = await client1.refresh().hold()
		await read.continueUntil({ afterProcessedBy: server })

		// Client1 edits after the server has prepared its older response.
		const edit = await client1.write(20).hold()
		expect(client1.read()).toBe(20)

		// The real client receives 10 and preserves its newer local edit.
		expect(await read.continue()).toBe(10)
		expect(client1.read()).toBe(20)
		expect(client1.isSaving()).toBe(true)
		expect(server.read()).toBe(10)

		expect(await edit.continue()).toBe(20)
		expect(await client2.refresh()).toBe(20)
	})

	test("preserves a pending local edit while receiving another client's change", async ({
		client1,
		client2,
		server,
	}) => {
		// Both clients start with the same value.
		await client1.write(5)
		await client2.refresh()

		// Client1 sees its edit locally, but it has not reached the server.
		const edit = await client1.write(10).hold()
		expect(client1.read()).toBe(10)
		expect(client1.isSaving()).toBe(true)
		expect(server.read()).toBe(5)

		// Client2's edit reaches the server first.
		expect(await client2.write(20)).toBe(20)
		expect(server.read()).toBe(20)

		// Client1 receives that change while retaining its pending local edit.
		expect(await client1.refresh()).toBe(20)
		expect(client1.read()).toBe(10)
		expect(client1.isSaving()).toBe(true)
		expect(server.read()).toBe(20)

		// Client1's write arrives last; both clients converge on its value.
		expect(await edit.continue()).toBe(10)
		await client1.refresh()
		await client2.refresh()
		expect(server.read()).toBe(10)
		expect(client1.read()).toBe(10)
		expect(client2.read()).toBe(10)
		expect(client1.isSaving()).toBe(false)
	})

	test("holds after asynchronous local preparation and before the first outgoing call", async () => {
		await using harness = new Gatekeeper()
			.add("server", () => new Server())
			.add("client1", ({ server }) => new PreparingClient(server))
			.build()
		const { client1, server } = harness

		// Awaiting hold includes preparation, even though it crosses an await.
		const call = await client1.write(10).hold()
		expect(client1.read()).toBe(10)
		expect(client1.isSaving()).toBe(true)
		expect(server.read()).toBe(0)

		// The outgoing call only reaches the receiver after release.
		expect(await call.continue()).toBe(10)
		expect(server.read()).toBe(10)
		expect(client1.isSaving()).toBe(false)
	})

	test("waits for a queued operation's first outgoing call before returning its hold", async ({
		client1,
		server,
	}) => {
		const first = await client1.write(10).hold()
		await first.continueUntil({ afterProcessedBy: server })

		// Start waiting for Second's outgoing call; First still owns its gate.
		const secondReady = client1.write(20).hold()

		// The first response must not finish or release the second operation.
		expect(await first.continue()).toBe(10)
		const second = await secondReady
		expect(client1.read()).toBe(20)
		expect(client1.isSaving()).toBe(true)

		await second.continueUntil({ beforeProcessedBy: server })
		expect(server.read()).toBe(10)
		expect(await second.continue()).toBe(20)
		expect(client1.isSaving()).toBe(false)
		expect(server.read()).toBe(20)
	})

	test("advances successive events when one public action revisits a service", async ({
		client1,
		server,
	}) => {
		const call = await client1.add(5).hold()

		// The first server interaction obtains the value without changing it.
		await call.continueUntil({ afterProcessedBy: server })
		expect(server.read()).toBe(0)
		expect(client1.read()).toBe(0)

		// After receiving that result, the client prepares its local update.
		await call.continueUntil({ beforeProcessedBy: server })
		expect(client1.read()).toBe(5)
		expect(server.read()).toBe(0)

		// A second event reaches the same service, still within the same action.
		await call.continueUntil({ afterProcessedBy: server })
		expect(server.read()).toBe(5)
		expect(client1.isSaving()).toBe(true)
		expect(await call.continue()).toBe(5)
	})

	test("fails before processing and lets the real caller roll back", async ({
		client1,
		server,
	}) => {
		const failure = new Error("Request lost")
		const call = await client1.write(10).hold()
		await call.continueUntil({ beforeProcessedBy: server })
		expect(client1.read()).toBe(10)

		// The injected rejection travels through the client's real catch handler.
		const result = await call.fail(failure)
		expect(result).toBeInstanceOf(DeliveryFailed)
		expect(result).toHaveProperty("cause", failure)
		expect(client1.read()).toBe(0)
		expect(client1.isSaving()).toBe(false)
		expect(server.read()).toBe(0)
	})

	test("reaches a selected service through an intermediate receiver", async () => {
		// This topology forwards Client2's request through Client1 to the server.
		await using harness = new Gatekeeper()
			.add("server", () => new Server())
			.add("client1", ({ server }) => new Client(server))
			.add("client2", ({ client1 }) => new Forwarder(client1))
			.build()
		const { client1, client2, server } = harness
		const call = await client2.write(10).hold()
		expect(client1.read()).toBe(0)

		// Reaching the chosen boundary requires real work on the intermediate client.
		await call.continueUntil({ beforeProcessedBy: server })
		expect(client1.read()).toBe(10)
		expect(server.read()).toBe(0)

		await call.continueUntil({ afterProcessedBy: server })
		expect(server.read()).toBe(10)
		expect(client1.isSaving()).toBe(true)

		// Results return through both services to the original public caller.
		expect(await call.continue()).toBe(10)
		expect(client1.isSaving()).toBe(false)
	})

	test("fails after processing without undoing the receiver's completed effects", async ({
		client1,
		client2,
		server,
	}) => {
		const failure = new Error("Response lost")
		const call = await client1.write(10).hold()
		await call.continueUntil({ afterProcessedBy: server })

		const result = await call.fail(failure)
		expect(result).toBeInstanceOf(DeliveryFailed)
		expect(result).toHaveProperty("cause", failure)
		expect(client1.read()).toBe(0)
		expect(client1.isSaving()).toBe(false)

		// Other consumers can still read the accepted value from the server.
		expect(server.read()).toBe(10)
		expect(await client2.refresh()).toBe(10)
	})

	test("preserves an application's returned error value", async ({
		client1,
		server,
	}) => {
		const call = await client1.write(-1).hold()
		await call.continueUntil({ afterProcessedBy: server })
		expect(client1.read()).toBe(-1)

		// An Error returned by the service stays a value, not a rejection.
		expect(await call.continue()).toBeInstanceOf(InvalidValue)
		expect(client1.read()).toBe(0)
		expect(server.read()).toBe(0)
	})

	test("preserves a rejection when the caller forwards its dependency's result", async () => {
		// This consumer transparently forwards the result instead of recovering.
		await using harness = new Gatekeeper()
			.add("server", () => new Server())
			.add("client", ({ server }) => ({
				save: (value: number) => server.store(value),
			}))
			.build()
		const { client, server } = harness
		const failure = new Error("Connection closed")
		const call = await client.save(10).hold()
		await call.continueUntil({ beforeProcessedBy: server })

		await expect(call.fail(failure)).rejects.toBe(failure)
		expect(server.read()).toBe(0)
	})

	test("waits for a queued call to reach its boundary after another call is released", async () => {
		await using harness = new Gatekeeper()
			.add("server", () => new Server())
			.add("client1", ({ server }) => new Client(server))
			.add("client2", ({ client1 }) => new Forwarder(client1))
			.build()
		const { client1, client2, server } = harness
		const first = await client1.write(10).hold()
		await first.continueUntil({ afterProcessedBy: server })
		// Second first pauses at the handoff from Client2 to Client1.
		const second = await client2.write(20).hold()

		// Start waiting; the client cannot send Second until First finishes.
		const secondReachesServer = second.continueUntil({
			beforeProcessedBy: server,
		})
		expect(server.read()).toBe(10)
		expect(client1.isSaving()).toBe(true)

		// Releasing First lets Second reach its requested boundary normally.
		expect(await first.continue()).toBe(10)
		await secondReachesServer
		expect(server.read()).toBe(10)
		expect(client1.isSaving()).toBe(true)

		// Second still needs its own release before the server processes it.
		expect(await second.continue()).toBe(20)
		expect(server.read()).toBe(20)
		expect(client1.isSaving()).toBe(false)
	})

	test("rejects hold when an operation completes without an outgoing service call", async ({
		server,
	}) => {
		// A direct local read succeeds normally, but offers no external call to hold.
		expect(await server.fetch()).toBe(0)
		await expect(server.fetch().hold()).rejects.toThrow(
			/no outgoing service call/i,
		)
	})

	test("rejects a boundary that is never reached before the operation completes", async ({
		client1,
		client2,
		server,
	}) => {
		const call = await client1.write(10).hold()

		// This operation visits Server and completes without visiting Client2.
		await expect(
			call.continueUntil({ beforeProcessedBy: client2 }),
		).rejects.toThrow(/boundary.*not reached/i)
		expect(server.read()).toBe(10)
		expect(client1.isSaving()).toBe(false)
	})

	test("rejects controls on a completed call without repeating its effects", async ({
		client1,
		client2,
		server,
	}) => {
		const call = await client1.write(10).hold()
		await call.continue()
		await client2.write(20)

		// A consumed handle cannot be released, advanced, or failed again.
		await expect(call.continue()).rejects.toThrow(/completed/i)
		await expect(
			call.continueUntil({ beforeProcessedBy: server }),
		).rejects.toThrow(/completed/i)
		await expect(call.fail(new Error("Too late"))).rejects.toThrow(/completed/i)
		expect(server.read()).toBe(20)
		expect(client1.read()).toBe(10)
	})
})
