import { Gatekeeper } from "@tanishqkancharla/gatekeeper"
import { describe, expect } from "vitest"
import {
	type Assert,
	codec,
	collection,
	date,
	defineRelations,
	defineSchema,
	partialObject,
	string,
	t,
	type Decoded,
	type Encoded,
	type RuntimeSchemaDefinition,
	TandemClient,
	type TestIsEqual,
	type SchemaToTupleSchema,
} from "@tanishqkancharla/tandem-core"
import { test } from "./fixtures.js"

describe("partial-object collection codecs", () => {
	test("uses the same field codecs for records and partial payloads", () => {
		const eventCodec = partialObject({
			id: string,
			title: string,
			startAt: date,
		})
		const startAt = new Date("2026-10-23T12:34:56.000Z")

		// A complete record and a one-field payload use identical field serialization.
		const record = { id: "event-1", title: "Planning", startAt }
		expect(eventCodec.encode(record)).toEqual({
			id: "event-1",
			title: "Planning",
			startAt: "2026-10-23T12:34:56.000Z",
		})
		expect(eventCodec.decode(eventCodec.encode(record))).toEqual(record)
		expect(eventCodec.encode({ startAt })).toEqual({
			startAt: "2026-10-23T12:34:56.000Z",
		})
		expect(eventCodec.decode({ startAt: "2026-10-23T12:34:56.000Z" })).toEqual({
			startAt,
		})

		// Empty input stays empty; partial decoding does not manufacture fields or identity.
		expect(eventCodec.encode({})).toEqual({})
		expect(eventCodec.decode({})).toEqual({})

		type _Decoded = Assert<
			TestIsEqual<
				Decoded<typeof eventCodec>,
				{ id?: string; title?: string; startAt?: Date }
			>
		>
		type _Encoded = Assert<
			TestIsEqual<
				Encoded<typeof eventCodec>,
				{ id?: string; title?: string; startAt?: string }
			>
		>
	})

	test("leaves nested validation and transformations to the declared field codec", () => {
		const interval = codec<{ start: Date; end: Date }, string[]>(
			"interval",
			(input) => {
				const value = input as { start: Date; end: Date }
				return [date.encode(value.start), date.encode(value.end)]
			},
			(input) => {
				const value = input as string[]
				return { start: date.decode(value[0]), end: date.decode(value[1]) }
			},
		)
		const eventCodec = partialObject({ id: string, interval })
		const payload = {
			interval: {
				start: new Date("2026-10-23T09:00:00.000Z"),
				end: new Date("2026-10-23T11:30:00.000Z"),
			},
		}

		// The outer codec treats a custom nested value as one field, not a recursive patch.
		expect(eventCodec.encode(payload)).toEqual({
			interval: ["2026-10-23T09:00:00.000Z", "2026-10-23T11:30:00.000Z"],
		})
		expect(eventCodec.decode(eventCodec.encode(payload))).toEqual(payload)

		// Partialness at the collection level does not relax a nested codec's requirements.
		expect(() =>
			eventCodec.encode({ interval: { start: payload.interval.start } }),
		).toThrow()
		expect(() =>
			eventCodec.decode({ interval: ["2026-10-23T09:00:00.000Z"] }),
		).toThrow()
		type _Nested = Assert<
			TestIsEqual<
				[Decoded<typeof eventCodec>["interval"]],
				[{ start: Date; end: Date } | undefined]
			>
		>
	})

	test.each(["encode", "decode"] as const)(
		"%s validates supplied fields",
		(direction) => {
			const eventCodec = partialObject({ id: string, title: string })

			// Partial means omitted keys, not arbitrary inputs or unknown fields.
			for (const input of [
				null,
				undefined,
				[],
				"title",
				{ missing: "value" },
				{ toString: "value" },
			]) {
				expect(() => eventCodec[direction](input)).toThrow()
			}

			// A supplied value must pass its field codec; undefined is not silently omitted.
			for (const title of [42, undefined]) {
				expect(() => eventCodec[direction]({ title })).toThrow()
			}
		},
	)

	test("requires record identity separately from partial codec values", async ({
		logger,
	}) => {
		const eventCodec = partialObject({
			id: string,
			title: string,
			startAt: date,
		})
		const schema = defineSchema({ events: collection({ codec: eventCodec }) })
		await using gatekeeper = new Gatekeeper()
			.add("client", () => new TandemClient({ schema, logger }))
			.build()
		await gatekeeper.client.ready
		const tx = gatekeeper.client.transact()

		// A payload can omit identity, but writing that payload as a record is rejected.
		expect(eventCodec.decode({ title: "Planning" })).toEqual({
			title: "Planning",
		})
		expect(() => {
			// @ts-expect-error Exercise the record identity requirement at runtime too.
			tx.set("events", { title: "Planning" })
		}).toThrow()

		// Other fields really are optional when the collection is inferred from its codec.
		tx.set("events", { id: "event-1" })
		await (
			await gatekeeper.client.commit(tx)
		).result
		expect(gatekeeper.client.query({ collection: "events" })).toEqual([
			{ id: "event-1" },
		])
	})
})

// Compile-time consumer contracts: partial payloads do not weaken record identity.
function checkPartialCollectionTypes() {
	const eventCodec = partialObject({ id: string, title: string, startAt: date })
	const schema = defineSchema({ events: collection({ codec: eventCodec }) })
	type Schema =
		typeof schema extends RuntimeSchemaDefinition<infer Value> ? Value : never
	type _Id = Assert<TestIsEqual<Schema["events"]["id"], string>>
	type _Title = Assert<
		TestIsEqual<[Schema["events"]["title"]], [string | undefined]>
	>
	type _StartAt = Assert<
		TestIsEqual<[Schema["events"]["startAt"]], [Date | undefined]>
	>

	function checkWrites(client: TandemClient<Schema>) {
		const tx = client.transact()
		tx.set("events", { id: "event-1" })
		// @ts-expect-error A record still needs identity, unlike a codec payload.
		tx.set("events", { startAt: new Date() })
		// @ts-expect-error The identity type comes from the declared id field codec.
		tx.set("events", { id: 12 })
		// @ts-expect-error Decoded field types, not storage types, reach the client API.
		tx.set("events", { id: "event-1", startAt: "2026-10-23" })
	}

	// @ts-expect-error A collection codec must declare an id field.
	collection({ codec: partialObject({ title: string }) })
	// @ts-expect-error A decoded Date cannot serve as a collection identity.
	collection({ codec: partialObject({ id: date }) })
	collection({
		// @ts-expect-error An arbitrary whole-record codec is not a partial-object codec.
		codec: codec(
			"opaque",
			() => ({ id: "1" }),
			() => ({ id: "1" }),
		),
	})
	return checkWrites
}

function makeSchema() {
	return defineSchema({
		users: collection({ id: t.id(), name: t.string() }),
		posts: collection({
			id: t.id(),
			authorId: t.string(),
			title: t.string(),
		}),
	})
}

describe("runtime schema relations", () => {
	test("registers and normalizes a many-to-one relation", () => {
		// Defining a valid many-to-one relation returns normalized relation metadata
		const relations = defineRelations(makeSchema(), ({ one }) => ({
			posts: {
				author: one("users", { from: "authorId", to: "id" }),
			},
		}))

		expect(relations.posts?.author).toEqual({
			type: "many-to-one",
			name: "author",
			sourceCollection: "posts",
			targetCollection: "users",
			from: "authorId",
			to: "id",
		})

		type _AuthorName = Assert<
			TestIsEqual<typeof relations.posts.author.name, "author">
		>
		type _AuthorTarget = Assert<
			TestIsEqual<typeof relations.posts.author.targetCollection, "users">
		>
		type _AuthorType = Assert<
			TestIsEqual<typeof relations.posts.author.type, "many-to-one">
		>
	})

	test("registers and normalizes a one-to-many relation", () => {
		// Defining a valid one-to-many relation returns normalized relation metadata
		const relations = defineRelations(makeSchema(), ({ many }) => ({
			users: {
				posts: many("posts", { from: "id", to: "authorId" }),
			},
		}))

		expect(relations.users?.posts).toEqual({
			type: "one-to-many",
			name: "posts",
			sourceCollection: "users",
			targetCollection: "posts",
			from: "id",
			to: "authorId",
		})

		type _PostsName = Assert<
			TestIsEqual<typeof relations.users.posts.name, "posts">
		>
		type _PostsTarget = Assert<
			TestIsEqual<typeof relations.users.posts.targetCollection, "posts">
		>
		type _PostsType = Assert<
			TestIsEqual<typeof relations.users.posts.type, "one-to-many">
		>
	})

	test("throws descriptive startup errors for invalid relation definitions", () => {
		// Unknown target collections are rejected while relations are defined
		expect(() =>
			defineRelations(makeSchema(), ({ one }) => ({
				posts: {
					author: one("missing" as any, { from: "authorId", to: "id" }),
				},
			})),
		).toThrow('Unknown target collection "missing" for relation "posts.author"')

		// Missing source fields are rejected before relation metadata is returned
		expect(() =>
			defineRelations(makeSchema(), ({ one }) => ({
				posts: {
					// @ts-expect-error Invalid source field intentionally exercises runtime validation
					author: one("users", { from: "missingAuthorId", to: "id" }),
				},
			})),
		).toThrow(
			'Missing source field "missingAuthorId" for relation "posts.author" on collection "posts"',
		)

		// Relation names cannot shadow fields on the source record
		expect(() =>
			defineRelations(makeSchema(), ({ one }) => ({
				posts: {
					title: one("users", { from: "authorId", to: "id" }),
				},
			})),
		).toThrow(
			'Relation "posts.title" collides with field "title" on collection "posts"',
		)

		// Many-to-one relations must join to the related record id
		expect(() =>
			defineRelations(makeSchema(), ({ one }) => ({
				posts: {
					author: one("users", { from: "authorId", to: "name" as any }),
				},
			})),
		).toThrow(
			'Relation "posts.author" must target the related record id; expected to="id", got to="name"',
		)

		// One-to-many relations must join from the source record id
		expect(() =>
			defineRelations(makeSchema(), ({ many }) => ({
				users: {
					posts: many("posts", { from: "name" as any, to: "authorId" }),
				},
			})),
		).toThrow(
			'Relation "users.posts" must start from the source record id; expected from="id", got from="name"',
		)
	})
})

type _TestSchemaToTupleSchema = Assert<
	TestIsEqual<
		SchemaToTupleSchema<{
			todos: {
				id: string
				text: string
				complete: boolean
			}
		}>,
		{
			key: ["record", "todos", string]
			value: { id: string; text: string; complete: boolean }
		}
	>
>

type _TestCompoundIdSchemaToTupleSchema = Assert<
	TestIsEqual<
		SchemaToTupleSchema<{
			entries: {
				id: readonly [sessionId: string, entryId: number]
				text: string
			}
		}>,
		{
			key: ["record", "entries", sessionId: string, entryId: number]
			value: {
				id: readonly [sessionId: string, entryId: number]
				text: string
			}
		}
	>
>
