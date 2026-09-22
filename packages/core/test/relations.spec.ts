import { Gatekeeper } from "@tanishqkancharla/gatekeeper"
import {
	collection,
	defineRelations,
	defineSchema,
	type LoggerApi,
	type RngApi,
	TandemClient,
} from "@tanishqkancharla/tandem-core"
import { describe, expect } from "vitest"
import { test } from "./fixtures.js"

type Thread = {
	id: string
	ownerId: string
	title: string
	status: "active" | "archived"
}

type ThreadSchema = {
	users: { id: string; profileId: string; name: string }
	profiles: { id: string; displayName: string }
	threads: Thread
	messages: { id: string; threadId: string; body: string; createdAt: number }
}

const threadSchema = defineSchema({
	users: collection<ThreadSchema["users"]>({
		fields: ["id", "profileId", "name"],
	}),
	profiles: collection<ThreadSchema["profiles"]>({
		fields: ["id", "displayName"],
	}),
	threads: collection<Thread>({
		fields: ["id", "ownerId", "title", "status"],
	}),
	messages: collection<ThreadSchema["messages"]>({
		fields: ["id", "threadId", "body", "createdAt"],
	}),
})

const threadRelations = defineRelations(threadSchema, ({ one, many }) => ({
	users: {
		profile: one("profiles", { from: "profileId", to: "id" }),
	},
	threads: {
		owner: one("users", { from: "ownerId", to: "id" }),
		messages: many("messages", { from: "id", to: "threadId" }),
	},
}))

function buildThreadGatekeeper({
	logger,
	rng,
}: {
	logger: LoggerApi
	rng: RngApi
}) {
	return new Gatekeeper()
		.add(
			"client1",
			() =>
				new TandemClient<ThreadSchema, typeof threadRelations>({
					schema: threadSchema,
					relations: threadRelations,
					logger,
					rng,
				}),
		)
		.build()
}

const threadTest = test.extend<{
	threadGatekeeper: ReturnType<typeof buildThreadGatekeeper>
}>({
	threadGatekeeper: async ({ logger, rng }, use) => {
		await using gatekeeper = buildThreadGatekeeper({
			logger,
			rng: rng.create("thread-client"),
		})
		await gatekeeper.client1.ready

		await use(gatekeeper)
		await gatekeeper.deactivateGatesAndSettle()
	},
})

describe("TandemClient relations", () => {
	threadTest(
		"runs relational object queries locally",
		async ({ threadGatekeeper }) => {
			const { client1: client } = threadGatekeeper
			// Seed users, threads, and messages related by many-to-one and one-to-many joins
			const tx = client.transact()
			tx.set("profiles", { id: "profile-1", displayName: "Ada Lovelace" })
			tx.set("profiles", { id: "profile-2", displayName: "Grace Hopper" })
			tx.set("users", { id: "user-1", profileId: "profile-1", name: "Ada" })
			tx.set("users", { id: "user-2", profileId: "profile-2", name: "Grace" })
			tx.set("threads", {
				id: "thread-1",
				ownerId: "user-1",
				title: "Active thread",
				status: "active",
			})
			tx.set("threads", {
				id: "thread-2",
				ownerId: "missing-user",
				title: "Archived thread",
				status: "archived",
			})
			tx.set("messages", {
				id: "message-1",
				threadId: "thread-1",
				body: "Older message",
				createdAt: 1,
			})
			tx.set("messages", {
				id: "message-2",
				threadId: "thread-1",
				body: "Newest message",
				createdAt: 2,
			})
			await (
				await client.commit(tx)
			).result

			// Query options filter/project parent rows while included relations resolve from omitted join fields
			const activeThreads = client.query({
				collection: "threads",
				select: { id: true, title: true },
				where: { status: "active" },
				with: {
					owner: { select: { name: true } },
					messages: {
						select: { body: true },
						orderBy: { createdAt: "desc" },
						limit: 1,
					},
				},
			})

			expect(activeThreads).toEqual([
				{
					id: "thread-1",
					title: "Active thread",
					owner: { name: "Ada" },
					messages: [{ body: "Newest message" }],
				},
			])

			// Missing many-to-one targets are returned as null, not arrays or omitted keys
			const archivedThreads = client.query({
				collection: "threads",
				select: { id: true },
				where: { status: "archived" },
				with: { owner: { select: { name: true } } },
			})

			expect(archivedThreads).toEqual([{ id: "thread-2", owner: null }])
		},
	)

	threadTest(
		"keeps relational object subscriptions live",
		async ({ threadGatekeeper }) => {
			const { client1: client } = threadGatekeeper
			// Seed a thread with a many-to-one owner, nested profile, and one-to-many messages
			const seedTx = client.transact()
			seedTx.set("profiles", { id: "profile-1", displayName: "Ada Lovelace" })
			seedTx.set("users", { id: "user-1", profileId: "profile-1", name: "Ada" })
			seedTx.set("threads", {
				id: "thread-1",
				ownerId: "user-1",
				title: "Active thread",
				status: "active",
			})
			seedTx.set("messages", {
				id: "message-1",
				threadId: "thread-1",
				body: "First message",
				createdAt: 1,
			})
			await (
				await client.commit(seedTx)
			).result

			let latestResult:
				| {
						id: string
						owner: {
							name: string
							profile: { displayName: string } | null
						} | null
						messages: { body: string }[]
				  }[]
				| undefined

			const subscription = client.subscribe(
				{
					collection: "threads",
					select: { id: true },
					with: {
						owner: {
							select: { name: true },
							with: { profile: { select: { displayName: true } } },
						},
						messages: {
							select: { body: true },
							orderBy: { createdAt: "asc" },
						},
					},
				},
				(result) => {
					latestResult = result
				},
			)

			// Initial relational subscription result is available synchronously
			expect(subscription.result).toEqual([
				{
					id: "thread-1",
					owner: {
						name: "Ada",
						profile: { displayName: "Ada Lovelace" },
					},
					messages: [{ body: "First message" }],
				},
			])
			expect(latestResult).toBeUndefined()

			// Updating an included child re-emits the parent row with updated embedded results
			const addMessageTx = client.transact()
			addMessageTx.set("messages", {
				id: "message-2",
				threadId: "thread-1",
				body: "Second message",
				createdAt: 2,
			})
			await (
				await client.commit(addMessageTx)
			).result

			expect(latestResult).toEqual([
				{
					id: "thread-1",
					owner: {
						name: "Ada",
						profile: { displayName: "Ada Lovelace" },
					},
					messages: [{ body: "First message" }, { body: "Second message" }],
				},
			])

			// Updating a nested included relation also re-emits the parent row
			const updateProfileTx = client.transact()
			updateProfileTx.update("profiles", "profile-1", (profile) => ({
				...profile,
				displayName: "Countess Lovelace",
			}))
			await (
				await client.commit(updateProfileTx)
			).result

			expect(latestResult).toEqual([
				{
					id: "thread-1",
					owner: {
						name: "Ada",
						profile: { displayName: "Countess Lovelace" },
					},
					messages: [{ body: "First message" }, { body: "Second message" }],
				},
			])

			// After unsubscribing, further child changes don't trigger the callback
			subscription.destroy()
			latestResult = undefined

			const quietMessageTx = client.transact()
			quietMessageTx.set("messages", {
				id: "message-3",
				threadId: "thread-1",
				body: "Quiet message",
				createdAt: 3,
			})
			await (
				await client.commit(quietMessageTx)
			).result

			expect(latestResult).toBeUndefined()
		},
	)
})
