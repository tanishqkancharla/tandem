import {
	collection,
	defineRelations,
	defineSchema,
} from "@tanishqkancharla/tandem-core"
import { expectTypeOf } from "vitest"
import { TandemServer } from "../src"
import type { TandemTuple, TandemServerStorageApi } from "../src"

type User = { id: string; name: string }
type Thread = { id: number; ownerId: string; title: string }
type AppSchema = { users: User; threads: Thread }

const schema = defineSchema({
	users: collection<User>({ fields: ["id", "name"] }),
	threads: collection<Thread>({
		fields: ["id", "ownerId", "title"],
	}),
})
const relations = defineRelations(schema, ({ one }) => ({
	threads: {
		owner: one("users", { from: "ownerId", to: "id" }),
	},
}))

declare const storage: TandemServerStorageApi<AppSchema>
expectTypeOf(storage.scan()).toEqualTypeOf<Promise<TandemTuple<AppSchema>[]>>()
expectTypeOf(storage.close()).toEqualTypeOf<Promise<void>>()

void storage.commit({
	set: [
		{
			key: ["record", "threads", 1],
			value: { id: 1, ownerId: "user-1", title: "Typed" },
		},
	],
})

void storage.commit({
	set: [
		{
			// @ts-expect-error Unknown collection names are rejected.
			key: ["record", "unknown", 1],
			value: { id: 1, ownerId: "user-1", title: "Typed" },
		},
	],
})

void storage.commit({
	set: [
		{
			// @ts-expect-error Thread IDs are numbers.
			key: ["record", "threads", "thread-1"],
			value: { id: 1, ownerId: "user-1", title: "Typed" },
		},
	],
})

void storage.commit({
	set: [
		// @ts-expect-error Tuple values stay correlated with their collection.
		{
			key: ["record", "threads", 1],
			value: { id: "user-1", name: "Ada" },
		},
	],
})

type OtherSchema = { users: { id: string; email: string } }
declare const otherSchemaStorage: TandemServerStorageApi<OtherSchema>

// @ts-expect-error Storage tuples must match the server schema.
const schemaMismatch: TandemServerStorageApi<AppSchema> = otherSchemaStorage
void schemaMismatch

// @ts-expect-error TandemServer rejects storage for a different schema.
new TandemServer({ schema, relations, storage: otherSchemaStorage })

// Storage is reusable with another relation definition over the same schema.
new TandemServer({ schema, relations: {}, storage })
