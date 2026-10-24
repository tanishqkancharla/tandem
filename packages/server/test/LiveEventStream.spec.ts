import http from "node:http"
import type { AddressInfo } from "node:net"
import {
	codec,
	collection,
	connectTandemEventSource,
	defineSchema,
	date,
	Logger,
	partialObject,
	string,
	tag,
	TandemClient,
	type ClientId,
	type RemoteApi,
} from "@tanishqkancharla/tandem-core"
import * as errore from "errore"
import { expect, test, vi } from "vitest"
import { createTandemEventStreamResponse, TandemServer } from "../src/index.js"
import { TestTandemServerStorage } from "./TandemServerStorage.fixture.js"

type Event = { id: number; title: string; startAt: Date }
type EventSchema = { events: Event }

const schema = defineSchema({
	events: collection<Event>({
		codec: partialObject({
			id: codec<number, string>(
				"eventId",
				(id) => `event-${id}`,
				(id) => Number((id as string).slice(6)),
			),
			title: string,
			startAt: date,
		}),
	}),
})

test("server-sent pokes show codec-backed records before any pull returns them", async () => {
	await using cleanup = new errore.AsyncDisposableStack()
	const server = new TandemServer({
		schema,
		relations: {},
		storage: new TestTandemServerStorage<EventSchema>(),
	})
	cleanup.defer(() => server.close())

	const events = new AbortController()
	const httpServer = http.createServer(async (request, response) => {
		const url = new URL(request.url!, "http://localhost")
		const stream = await createTandemEventStreamResponse({
			remote: server,
			clientId: tag<ClientId>(url.searchParams.get("clientId")!),
			schema,
			signal: events.signal,
		})
		response.writeHead(stream.status, Object.fromEntries(stream.headers))
		const reader = stream.body!.getReader()
		response.on("close", () => void reader.cancel())
		for (;;) {
			const { done, value } = await reader.read()
			if (done) break
			response.write(value)
		}
		response.end()
	})
	await new Promise<void>((resolve) => httpServer.listen(0, resolve))
	cleanup.defer(
		() => new Promise<void>((resolve) => httpServer.close(() => resolve())),
	)
	cleanup.defer(() => events.abort())
	const { port } = httpServer.address() as AddressInfo

	// Once the stream is ready, pulls wait until the test ends, so only pokes deliver.
	let streamReady = false
	const { promise: released, resolve: release } = Promise.withResolvers<void>()
	cleanup.defer(() => release())
	const remote: RemoteApi<EventSchema> = {
		connect: ({ clientId, poke }) =>
			Promise.resolve(
				connectTandemEventSource({
					url: `http://localhost:${port}/?clientId=${clientId}`,
					// The ready event's pull runs once the stream is registered, so
					// it records the client's view; later pulls wait.
					poke: async (payload) => {
						await poke(payload)
						if (!payload) streamReady = true
					},
					schema,
					pullInterval: null,
				}),
			),
		pull: async (args) => {
			if (streamReady) await released
			return server.pull(args)
		},
		push: (args) => server.push(args),
	}
	const client = new TandemClient<EventSchema, {}>({
		schema,
		remote,
		logger: new Logger({ sinks: [] }),
		syncInterval: 0,
	})
	cleanup.defer(() => client.disconnect())
	client.subscribe({ collection: "events" })
	// A real stream connects in its own time, so allow more than the default second.
	const waitOptions = { timeout: 10_000 }
	await vi.waitFor(() => expect(streamReady).toBe(true), waitOptions)

	const event = {
		id: 42,
		title: "Launch",
		startAt: new Date("2026-03-04T18:30:00.000Z"),
	}
	const tx = server.transact()
	tx.set("events", event)
	await server.commit(tx)

	await vi.waitFor(
		() => expect(client.query({ collection: "events" })).toEqual([event]),
		waitOptions,
	)
	expect(client.query({ collection: "events" })[0]!.startAt).toBeInstanceOf(
		Date,
	)
})
