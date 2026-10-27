import {
	collection,
	defineMutators,
	defineRelations,
	defineSchema,
} from "@tanishqkancharla/tandem-core"
import type { RemoteApi, UpdateMutationOp } from "@tanishqkancharla/tandem-core"
import { expectTypeOf } from "vitest"
import type { TandemServerStorageApi } from "../src/index.js"
import { TandemServer } from "../src/index.js"
// @ts-expect-error Tagged internal errors are not part of the package API.
import type { TandemServerError } from "../src/index.js"

expectTypeOf<TandemServerError>()

type User = { id: string; name: string }
type Thread = { id: string; ownerId: string; title: string; rank: number }
type Message = { id: string; threadId: string; body: string }
type Entry = { id: readonly [sessionId: string, entryId: number]; body: string }
type AppSchema = {
	users: User
	threads: Thread
	messages: Message
	entries: Entry
}

const schema = defineSchema({
	users: collection<User>({ fields: ["id", "name"] }),
	threads: collection<Thread>({
		fields: ["id", "ownerId", "title", "rank"],
	}),
	messages: collection<Message>({ fields: ["id", "threadId", "body"] }),
	entries: collection<Entry>({ fields: ["id", "body"] }),
})
const relations = defineRelations(schema, ({ one, many }) => ({
	threads: {
		owner: one("users", { from: "ownerId", to: "id" }),
		messages: many("messages", { from: "id", to: "threadId" }),
	},
}))

declare const storage: TandemServerStorageApi<AppSchema>
const server = new TandemServer({ schema, relations, storage })
expectTypeOf(server).toEqualTypeOf<TandemServer<AppSchema, typeof relations>>()
const remote: RemoteApi<AppSchema> = server
void remote

const update: UpdateMutationOp<AppSchema> = {
	type: "update",
	collection: "entries",
	id: ["session-1", 7],
	payload: { body: "Partial assignment" },
}
expectTypeOf(update.payload.body).toEqualTypeOf<string | undefined>()
const wrongIdentity = {
	type: "update",
	collection: "entries",
	id: "entry-1",
	payload: { body: "Invalid" },
} as const
// @ts-expect-error Update identity must match its collection's ID type.
void (wrongIdentity satisfies UpdateMutationOp<AppSchema>)
void ({
	type: "update",
	collection: "users",
	id: "user-1",
	// @ts-expect-error Payload fields belong to the selected collection.
	payload: { body: "Invalid" },
} satisfies UpdateMutationOp<AppSchema>)
void ({
	type: "update",
	collection: "threads",
	id: "thread-1",
	// @ts-expect-error Supplied field values retain their declared runtime types.
	payload: { rank: "wrong" },
} satisfies UpdateMutationOp<AppSchema>)
void ({
	type: "update",
	collection: "users",
	id: "user-1",
	// @ts-expect-error Record identity is not an editable payload field.
	payload: { id: "user-2" },
} satisfies UpdateMutationOp<AppSchema>)

declare const pushResponse: Awaited<ReturnType<typeof remote.push>>
// @ts-expect-error A failed push does not have the success marker.
void pushResponse.ok
if ("error" in pushResponse && pushResponse.error === "mutation-gap") {
	expectTypeOf(pushResponse.expectedMutationId).toEqualTypeOf<number>()
	expectTypeOf(pushResponse.receivedMutationId).toEqualTypeOf<number>()
}
declare const pullResponse: Awaited<ReturnType<typeof remote.pull>>
// @ts-expect-error A failed pull has no acknowledgement to apply.
void pullResponse.lastMutationId
if ("error" in pullResponse) {
	expectTypeOf(pullResponse.error).toEqualTypeOf<
		"unavailable" | "invalid-request"
	>()
}

const transaction = server.transact()
expectTypeOf(server.commit(transaction)).toEqualTypeOf<Promise<void>>()
expectTypeOf(
	transaction.update("threads", "thread-1", { title: "Partial" }),
).toEqualTypeOf<Promise<typeof transaction>>()
void transaction.update("entries", ["session-1", 1], { body: "Partial" })
// @ts-expect-error Update IDs stay correlated with the selected collection.
void transaction.update("entries", "entry-1", { body: "Invalid" })
// @ts-expect-error Update payload fields belong to the selected collection.
void transaction.update("users", "user-1", { title: "Invalid" })
// @ts-expect-error Update field values retain their runtime types.
void transaction.update("threads", "thread-1", { rank: "Invalid" })
// @ts-expect-error Record identity is not an editable field.
void transaction.update("threads", "thread-1", { id: "thread-2" })
// @ts-expect-error Update callbacks are replaced by explicit partial objects.
void transaction.update("threads", "thread-1", () => ({ id: "thread-1" }))

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

void transaction.get("entries", ["session-1", 1])
void transaction.scan("entries", { prefix: ["session-1"] })
void transaction.scan("entries", {
	prefix: ["session-1", 1],
	limit: 1,
	reverse: true,
})

// @ts-expect-error Compound ID prefix parts retain their declared types.
void transaction.scan("entries", { prefix: [1] })

// @ts-expect-error A compound ID scan cannot exceed the ID tuple length.
void transaction.scan("entries", { prefix: ["session-1", 1, "extra"] })

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

const shared = defineMutators(schema, {
	appendBody: {
		args: (input: unknown) => input as { id: string; text: string },
		run: async (tx, { id, text }) => {
			const message = await tx.get("messages", id)
			if (message) tx.set("messages", { ...message, body: message.body + text })
		},
	},
})
const registered = new TandemServer({
	schema,
	relations,
	storage,
	mutators: shared,
	hooks: (session: { user: string } | undefined) => ({
		appendBody: {
			authorize: async (tx, args, ctx) => {
				expectTypeOf(args).toEqualTypeOf<{ id: string; text: string }>()
				expectTypeOf(session).toEqualTypeOf<{ user: string } | undefined>()
				expectTypeOf(ctx.source).toEqualTypeOf<"client" | "server">()
				expectTypeOf(await tx.get("threads", "thread-1")).toEqualTypeOf<
					Readonly<Thread> | undefined
				>()
				// @ts-expect-error Hook transaction uses the registered schema.
				void tx.get("missing", "id")
				// @ts-expect-error Hook args come from appendBody.
				void args.missing
			},
		},
	}),
})
void registered.mutate("appendBody", { id: "message-1", text: "!" })
void registered.push(
	{ clientId: "client-1" as never, mutations: [] },
	{ context: { user: "ada" } },
)
void registered.push(
	{ clientId: "client-1" as never, mutations: [] },
	{
		context: {
			// @ts-expect-error Request context must match the hooks factory's session.
			user: 42,
		},
	},
)
// @ts-expect-error Unknown direct mutation names are excluded.
void registered.mutate("missing", { id: "message-1" })
// @ts-expect-error appendBody requires text.
void registered.mutate("appendBody", { id: "message-1" })
// @ts-expect-error appendBody text is a string.
void registered.mutate("appendBody", { id: "message-1", text: 42 })

// The documented mode-dependent hook retains contextual argument inference.
function createGuideServer(mode: "client" | "server" | "worker") {
	return new TandemServer({
		schema,
		relations,
		storage,
		mutators: shared,
		hooks: () => ({
			appendBody: {
				afterCommit:
					mode === "server"
						? ({ id, text }) => {
								expectTypeOf(id).toEqualTypeOf<string>()
								expectTypeOf(text).toEqualTypeOf<string>()
								return Promise.resolve()
							}
						: undefined,
			},
		}),
	})
}
void createGuideServer
