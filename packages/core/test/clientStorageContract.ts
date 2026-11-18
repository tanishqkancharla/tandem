import {
	codec,
	partialObject,
	string,
	tag,
	type AnySchema,
	type ClientId,
	type Cookie,
	type MutationId,
	TandemClient,
	type TandemClientStorageApi,
	type TandemClientTuple,
} from "@tanishqkancharla/tandem-core"
import { assert, describe, expect } from "vitest"
import { test, type MakeStorageOptions } from "./fixtures.js"
import {
	buildClientGatekeeper,
	EventStart,
	testsEventRuntimeSchema,
	type TestsEventSchema,
} from "./testsEvents.js"

export type OpenStorage = <Schema extends AnySchema>(
	options: MakeStorageOptions<Schema> & { dbName: string },
) => TandemClientStorageApi<Schema>

/**
 * Behavior every client storage adapter must keep. A storage opened again
 * with the same `dbName` must see what earlier ones committed.
 */
export function describeClientStorageContract(
	adapter: string,
	open: OpenStorage,
) {
	const storageTest = test.extend<{
		openStorage: <Schema extends AnySchema>(
			options?: MakeStorageOptions<Schema>,
		) => TandemClientStorageApi<Schema>
	}>({
		openStorage: async ({ rng }, use) => {
			const opened: TandemClientStorageApi<any>[] = []
			await use((options = {}) => {
				const storage = open({
					...options,
					dbName: options.dbName ?? rng.next("storage"),
				})
				opened.push(storage)
				return storage
			})
			for (const storage of opened) {
				await storage.clear()
				await storage.close()
			}
		},
	})
	describe(`${adapter} client storage contract`, () => {
		storageTest(
			"scans in key order with bounds, limits, and direction, and clears",
			async ({ openStorage }) => {
				const storage = openStorage<TestsEventSchema>()
				const record = (id: string): TandemClientTuple<TestsEventSchema> => ({
					key: ["record", "events", id],
					value: { id, title: id, startAt: new EventStart("2026-05-04") },
				})
				await storage.commit({ set: [record("c"), record("a"), record("b")] })
				// Committing a later batch removes keys and adds new ones together.
				await storage.commit({
					set: [record("d")],
					remove: [["record", "events", "c"]],
				})

				const ids = (tuples: TandemClientTuple<TestsEventSchema>[]) =>
					tuples.map(({ key }) => key[2])
				expect(ids(await storage.scan())).toEqual(["a", "b", "d"])
				expect(ids(await storage.scan({ reverse: true, limit: 2 }))).toEqual([
					"d",
					"b",
				])
				expect(
					ids(
						await storage.scan({
							gt: ["record", "events", "a"],
							lte: ["record", "events", "d"],
						}),
					),
				).toEqual(["b", "d"])

				// Clearing removes every tuple.
				await storage.clear()
				expect(await storage.scan()).toEqual([])
			},
		)

		storageTest(
			"round-trips replica metadata, sparse bases, and ordered outbox operations alongside codec-backed records",
			async ({ openStorage, rng, logger }) => {
				const dbName = rng.next("replica-tuples")
				const storage = openStorage<TestsEventSchema>({
					dbName,
					schema: testsEventRuntimeSchema,
				})
				const event = {
					id: "event-1",
					title: "Confirmed",
					startAt: new EventStart("2026-05-04T12:00:00.000Z"),
				}
				const edited = {
					...event,
					title: "Pending",
					startAt: new EventStart("2026-05-05T16:30:00.000Z"),
				}
				const mutationId = tag<MutationId>(8)
				const tuples: TandemClientTuple<TestsEventSchema>[] = [
					// The saved record is the base with the pending operations applied.
					{ key: ["record", "events", event.id], value: edited },
					{
						key: ["base", "events", event.id],
						value: {
							server: { type: "set", value: event },
							lastWrittenBy: mutationId,
						},
					},
					{
						key: ["base", "events", "event-2"],
						value: { server: { type: "remove" }, lastWrittenBy: mutationId },
					},
					{
						key: ["replica"],
						value: {
							clientId: tag<ClientId>("client-a"),
							lastIssuedMutationId: mutationId,
							cookie: tag<Cookie>("view-b"),
						},
					},
					{
						key: ["outbox", mutationId],
						value: [
							{ type: "remove", collection: "events", id: "event-2" },
							{ type: "set", collection: "events", value: edited },
							{
								type: "update",
								collection: "events",
								id: event.id,
								payload: { startAt: edited.startAt },
							},
						],
					},
				]
				await storage.commit({ set: tuples })
				await storage.close()

				// A new adapter restores class instances in bases and outbox operations, and explicit absence.
				const reopened = openStorage<TestsEventSchema>({
					dbName,
					schema: testsEventRuntimeSchema,
				})
				const restored = await reopened.scan()
				expect(restored).toHaveLength(5)
				expect(restored).toEqual(expect.arrayContaining(tuples))
				const outbox = restored.find((tuple) => tuple.key[0] === "outbox")
				assert(outbox && Array.isArray(outbox.value))
				const set = outbox.value[1]
				assert(set?.type === "set")
				expect(set.value.startAt).toBeInstanceOf(EventStart)
				const update = outbox.value[2]
				assert(update?.type === "update")
				expect(update.payload).toEqual({ startAt: edited.startAt })
				expect(update.payload.startAt).toBeInstanceOf(EventStart)
				const base = restored.find(
					(tuple) => tuple.key[0] === "base" && tuple.key[2] === event.id,
				)
				assert(
					base && "server" in base.value && base.value.server.type === "set",
				)
				expect(base.value.server.value.startAt).toBeInstanceOf(EventStart)

				// Hydration exposes only record tuples to application queries.
				await using harness = buildClientGatekeeper(
					new TandemClient<TestsEventSchema>({
						schema: testsEventRuntimeSchema,
						clientStorage: reopened,
						logger,
						autoConnect: false,
					}),
				)
				await harness.client.ready
				expect(harness.client.query({ collection: "events" })).toEqual([edited])

				// Removing an outbox entry leaves records, bases, and metadata untouched.
				await reopened.commit({ remove: [["outbox", mutationId]] })
				expect(await reopened.scan()).toEqual(
					expect.arrayContaining(
						tuples.filter((tuple) => tuple.key[0] !== "outbox"),
					),
				)
				expect(await reopened.scan()).toHaveLength(4)
			},
		)

		storageTest.for(["set", "update"] as const)(
			"does not persist a batch prefix when an outbox %s codec fails",
			async (type, { openStorage, rng }) => {
				const storage = openStorage<TestsEventSchema>({
					dbName: rng.next("failed-outbox-codec"),
					codecs: {
						events: partialObject({
							id: string,
							title: string,
							startAt: codec<EventStart, string>(
								"reject",
								() => {
									throw new Error("Cannot encode event")
								},
								(value) => new EventStart(value as string),
							),
						}),
					},
				})
				await expect(
					storage.commit({
						set: [
							{
								key: ["replica"],
								value: {
									clientId: tag<ClientId>("client-a"),
									lastIssuedMutationId: tag<MutationId>(1),
								},
							},
							{
								key: ["outbox", tag<MutationId>(1)],
								value: [
									type === "set"
										? {
												type,
												collection: "events",
												value: {
													id: "event-1",
													title: "Rejected",
													startAt: new EventStart("2026-05-04"),
												},
											}
										: {
												type,
												collection: "events",
												id: "event-1",
												payload: { startAt: new EventStart("2026-05-04") },
											},
								],
							},
						],
					}),
				).rejects.toThrow("Cannot encode event")
				expect(await storage.scan()).toEqual([])
			},
		)
	})
}
