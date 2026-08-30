import { describe, expect, test } from "vitest"
import {
	type EncodedQuery,
	type Mutation,
	MutationApi,
} from "@tanishqkancharla/tandem-core"

type TestSchema = {
	threads: { id: string; ownerId: string; title: string }
	users: { id: string; profileId: string; name: string }
	profiles: { id: string; displayName: string }
	messages: { id: string; threadId: string; body: string }
}

function mutation(
	collection: keyof TestSchema & string,
	value: TestSchema[keyof TestSchema],
): Mutation<TestSchema> {
	return {
		id: `mutation-${collection}` as Mutation<TestSchema>["id"],
		ops: [{ type: "set", collection, value }],
	} as Mutation<TestSchema>
}

describe("MutationApi", () => {
	test("intersects flat queries by root collection", () => {
		const query: EncodedQuery<TestSchema> = { collection: "threads" }
		const threadMutation = mutation("threads", {
			id: "thread-1",
			ownerId: "user-1",
			title: "Thread",
		})

		expect(MutationApi.intersectsQuery(threadMutation, query)).toBe(true)
	})

	test("intersects included and nested included query collections", () => {
		const query: EncodedQuery<TestSchema> = {
			collection: "threads",
			with: {
				owner: {
					collection: "users",
					with: {
						profile: { collection: "profiles" },
					},
				},
				messages: { collection: "messages" },
			},
		}

		// A direct included child collection intersects even when the root collection differs
		const messageMutation = mutation("messages", {
			id: "message-1",
			threadId: "thread-1",
			body: "Hello",
		})
		expect(MutationApi.intersectsQuery(messageMutation, query)).toBe(true)

		// A nested included child collection also intersects the root scan-window query
		const profileMutation = mutation("profiles", {
			id: "profile-1",
			displayName: "Ada Lovelace",
		})
		expect(MutationApi.intersectsQuery(profileMutation, query)).toBe(true)
	})

	test("does not intersect unrelated collections", () => {
		const query: EncodedQuery<TestSchema> = {
			collection: "threads",
			with: {
				messages: { collection: "messages" },
			},
		}
		const userMutation = mutation("users", {
			id: "user-1",
			profileId: "profile-1",
			name: "Ada",
		})

		expect(MutationApi.intersectsQuery(userMutation, query)).toBe(false)
	})
})
