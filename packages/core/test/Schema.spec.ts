import { describe, expect } from "vitest"
import { collection, defineRelations, defineSchema, t } from "../src"
import { test } from "./fixtures"

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
	test("registers and normalizes a one relation", () => {
		// Defining a valid one relation returns normalized relation metadata
		const relations = defineRelations(makeSchema(), ({ one }) => ({
			posts: {
				author: one("users", { from: "authorId", to: "id" }),
			},
		}))

		expect(relations.posts?.author).toEqual({
			kind: "one",
			name: "author",
			sourceCollection: "posts",
			targetCollection: "users",
			from: "authorId",
			to: "id",
		})
	})

	test("registers and normalizes a many relation", () => {
		// Defining a valid many relation returns normalized relation metadata
		const relations = defineRelations(makeSchema(), ({ many }) => ({
			users: {
				posts: many("posts", { from: "id", to: "authorId" }),
			},
		}))

		expect(relations.users?.posts).toEqual({
			kind: "many",
			name: "posts",
			sourceCollection: "users",
			targetCollection: "posts",
			from: "id",
			to: "authorId",
		})
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

		// One relations must join to the related record id
		expect(() =>
			defineRelations(makeSchema(), ({ one }) => ({
				posts: {
					author: one("users", { from: "authorId", to: "name" as any }),
				},
			})),
		).toThrow(
			'Relation "posts.author" must target the related record id; expected to="id", got to="name"',
		)

		// Many relations must join from the source record id
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
