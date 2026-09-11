import {
	AsyncTupleDatabase,
	AsyncTupleDatabaseClient,
	InMemoryTupleStorage,
	TupleDatabase,
	TupleDatabaseClient,
} from "tuple-database"
import { expect, expectTypeOf, test as baseTest } from "vitest"
import { executeQueryAsync, executeQuerySync } from "../src/internal"
import { collection, defineRelations, defineSchema } from "../src/schema/Schema"
import type { SchemaToTupleSchema } from "../src/schema/Schema"

type User = {
	id: string
	name: string
}

type Thread = {
	id: string
	ownerId: string
	title: string
	status: "active" | "archived"
}

type Message = {
	id: string
	threadId: string
	body: string
	createdAt: number
}

type QuerySchema = {
	users: User
	threads: Thread
	messages: Message
}

const schema = defineSchema({
	users: collection<User>({ fields: ["id", "name"] }),
	threads: collection<Thread>({
		fields: ["id", "ownerId", "title", "status"],
	}),
	messages: collection<Message>({
		fields: ["id", "threadId", "body", "createdAt"],
	}),
})

const relations = defineRelations(schema, ({ one, many }) => ({
	threads: {
		owner: one("users", { from: "ownerId", to: "id" }),
		messages: many("messages", { from: "id", to: "threadId" }),
	},
}))

const tuples: SchemaToTupleSchema<QuerySchema>[] = [
	{
		key: ["record", "users", "user-1"],
		value: { id: "user-1", name: "Ada" },
	},
	{
		key: ["record", "threads", "thread-1"],
		value: {
			id: "thread-1",
			ownerId: "user-1",
			title: "Alpha",
			status: "active",
		},
	},
	{
		key: ["record", "threads", "thread-2"],
		value: {
			id: "thread-2",
			ownerId: "missing-user",
			title: "Zulu",
			status: "archived",
		},
	},
	{
		key: ["record", "threads", "thread-3"],
		value: {
			id: "thread-3",
			ownerId: "user-1",
			title: "Charlie",
			status: "active",
		},
	},
	{
		key: ["record", "threads", "thread-4"],
		value: {
			id: "thread-4",
			ownerId: "user-1",
			title: "Bravo",
			status: "active",
		},
	},
	{
		key: ["record", "messages", "message-1"],
		value: {
			id: "message-1",
			threadId: "thread-1",
			body: "First",
			createdAt: 1,
		},
	},
	{
		key: ["record", "messages", "message-2"],
		value: {
			id: "message-2",
			threadId: "thread-1",
			body: "Latest",
			createdAt: 2,
		},
	},
]

type TupleSchema = SchemaToTupleSchema<QuerySchema>

const test = baseTest.extend<{
	syncDb: TupleDatabaseClient<TupleSchema>
	asyncDb: AsyncTupleDatabaseClient<TupleSchema>
}>({
	syncDb: async ({}, use) => {
		const storage = new InMemoryTupleStorage()
		storage.commit({ set: [...tuples] })
		const db = new TupleDatabaseClient<TupleSchema>(new TupleDatabase(storage))

		await use(db)

		db.close()
	},
	asyncDb: async ({}, use) => {
		const storage = new InMemoryTupleStorage()
		storage.commit({ set: [...tuples] })
		const db = new AsyncTupleDatabaseClient<TupleSchema>(
			new AsyncTupleDatabase(storage),
		)

		await use(db)

		await db.close()
	},
})

test("sync and async execution apply scalar query options identically", async ({
	syncDb,
	asyncDb,
}) => {
	const query = {
		collection: "threads",
		where: { status: "active" },
		orderBy: { title: "desc" },
		offset: 1,
		limit: 1,
		select: { id: true, title: true },
	} as const

	const syncResult = executeQuerySync<
		QuerySchema,
		typeof relations,
		typeof query
	>(syncDb, relations, query)
	const asyncResult = await executeQueryAsync<
		QuerySchema,
		typeof relations,
		typeof query
	>(asyncDb, relations, query)

	expect(syncResult).toEqual([{ id: "thread-4", title: "Bravo" }])
	expect(asyncResult).toEqual(syncResult)
	expectTypeOf(syncResult).toEqualTypeOf<{ id: string; title: string }[]>()
	expectTypeOf(asyncResult).toEqualTypeOf(syncResult)
})

test("sync and async execution expand relations identically", async ({
	syncDb,
	asyncDb,
}) => {
	const query = {
		collection: "threads",
		where: { id: "thread-1" },
		select: { id: true },
		with: {
			owner: { select: { name: true } },
			messages: {
				select: { body: true },
				orderBy: { createdAt: "desc" },
				limit: 1,
			},
		},
	} as const

	const syncResult = executeQuerySync<
		QuerySchema,
		typeof relations,
		typeof query
	>(syncDb, relations, query)
	const asyncResult = await executeQueryAsync<
		QuerySchema,
		typeof relations,
		typeof query
	>(asyncDb, relations, query)

	expect(syncResult).toEqual([
		{
			id: "thread-1",
			owner: { name: "Ada" },
			messages: [{ body: "Latest" }],
		},
	])
	expect(asyncResult).toEqual(syncResult)
	expectTypeOf(syncResult).toMatchTypeOf<
		{
			id: string
			readonly owner: { name: string } | null
			readonly messages: { body: string }[]
		}[]
	>()
	expectTypeOf(syncResult[0]).not.toBeAny()
	expectTypeOf(asyncResult).toEqualTypeOf(syncResult)
})
