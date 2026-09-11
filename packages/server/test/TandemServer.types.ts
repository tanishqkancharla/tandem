import {
	collection,
	defineRelations,
	defineSchema,
} from "@tanishqkancharla/tandem-core"
import { expectTypeOf } from "vitest"
import type { TandemServerStorageApi } from "../src"
import { TandemServer } from "../src"
// @ts-expect-error Tagged internal errors are not part of the package API.
import type { TandemServerError } from "../src"

expectTypeOf<TandemServerError>()

type User = { id: string; name: string }
type Thread = { id: string; ownerId: string; title: string; rank: number }
type Message = { id: string; threadId: string; body: string }
type AppSchema = { users: User; threads: Thread; messages: Message }

const schema = defineSchema({
	users: collection<User>({ fields: ["id", "name"] }),
	threads: collection<Thread>({
		fields: ["id", "ownerId", "title", "rank"],
	}),
	messages: collection<Message>({ fields: ["id", "threadId", "body"] }),
})
const relations = defineRelations(schema, ({ one, many }) => ({
	threads: {
		owner: one("users", { from: "ownerId", to: "id" }),
		messages: many("messages", { from: "id", to: "threadId" }),
	},
}))

declare const storage: TandemServerStorageApi<AppSchema>
const server = new TandemServer({ schema, relations, storage })
const transaction = server.transact()
expectTypeOf(server.commit(transaction)).toEqualTypeOf<Promise<void>>()

// @ts-expect-error The underlying tuple transaction is an implementation detail.
void transaction.tupleDbTx

void transaction.set("threads", {
	id: "thread-1",
	ownerId: "user-1",
	title: "Typed",
	rank: 1,
})

// @ts-expect-error Transaction collection names come from the server schema.
void transaction.get("unknown", "record-1")

// @ts-expect-error Transaction IDs stay correlated with their collection.
void transaction.get("threads", 1)

// @ts-expect-error Transaction records must match their collection value.
void transaction.set("threads", { id: "thread-1", name: "Ada" })

async function assertQueryTypes() {
	const transactionResult = await transaction.query({
		collection: "threads",
		select: { title: true },
		with: { owner: { select: { name: true } } },
	})
	expectTypeOf(transactionResult).toMatchTypeOf<
		{
			title: string
			readonly owner: { name: string } | null
		}[]
	>()

	const result = await server.query({
		collection: "threads",
		select: { id: true, title: true },
		with: {
			owner: { select: { name: true } },
			messages: { select: { body: true } },
		},
	})
	expectTypeOf(result).not.toBeAny()

	expectTypeOf(result).toMatchTypeOf<
		{
			id: string
			title: string
			readonly owner: { name: string } | null
			readonly messages: { body: string }[]
		}[]
	>()

	const subscription = await server.subscribe(
		{
			collection: "threads",
			select: { title: true },
			with: { messages: { select: { body: true } } },
		},
		(value) => {
			expectTypeOf(value).toMatchTypeOf<
				{
					title: string
					readonly messages: { body: string }[]
				}[]
			>()
		},
		{ onError: (error) => expectTypeOf(error).toEqualTypeOf<Error>() },
	)
	expectTypeOf(subscription.result).not.toBeAny()
	expectTypeOf(subscription.result).toMatchTypeOf<
		{
			title: string
			readonly messages: { body: string }[]
		}[]
	>()
}
void assertQueryTypes

// @ts-expect-error Unknown collections are rejected.
void server.query({ collection: "unknown" })

// @ts-expect-error Unknown fields are rejected.
void server.query({ collection: "threads", where: { missing: true } })

void server.query({
	collection: "threads",
	with: {
		// @ts-expect-error Unknown relations are rejected.
		missing: true,
	},
})

// @ts-expect-error Transaction queries use the server's collection names.
void transaction.query({ collection: "unknown" })
