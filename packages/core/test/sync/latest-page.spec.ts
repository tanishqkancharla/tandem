import {
	collection,
	defineRelations,
	defineSchema,
	TandemClient,
} from "@tanishqkancharla/tandem-core"
import type { TandemServer } from "@tanishqkancharla/tandem-server"
import * as errore from "errore"
import { describe, expect } from "vitest"
import { buildGatekeeperHarness, expectQuery, test } from "../fixtures.js"

type Category = { id: string; name: string }
type Todo = {
	id: string
	ownerId: string
	categoryId: string
	done: boolean
	createdAt: number
}
type TodoSchema = { categories: Category; todos: Todo }

const schema = defineSchema({
	categories: collection<Category>({ fields: ["id", "name"] }),
	todos: collection<Todo>({
		fields: ["id", "ownerId", "categoryId", "done", "createdAt"],
		indexes: { byOwner: ["ownerId", "done", "createdAt"] },
	}),
})

const relations = defineRelations(schema, ({ one }) => ({
	todos: { category: one("categories", { from: "categoryId", to: "id" }) },
}))

const page = {
	collection: "todos",
	where: { ownerId: "ada", done: false },
	orderBy: { createdAt: "desc" },
	limit: 50,
	with: { category: true },
} as const

const pageTest = test.extend<{
	chat: TandemServer<TodoSchema, typeof relations>
	harness: ReturnType<
		typeof buildGatekeeperHarness<
			TodoSchema,
			TandemClient<TodoSchema, typeof relations>
		>
	>
}>({
	chat: async ({ makeRemote }, use) => {
		await use(makeRemote({ schema, relations }))
	},
	harness: async ({ chat, logger, rng }, use) => {
		const clients: TandemClient<TodoSchema, typeof relations>[] = []
		await using cleanup = new errore.AsyncDisposableStack()
		await using harness = buildGatekeeperHarness({
			server: chat,
			createClient: (remote, label) => {
				const client = new TandemClient<TodoSchema, typeof relations>({
					schema,
					relations,
					remote,
					logger,
					rng: rng.create(label),
					autoConnect: false,
					syncInterval: 0,
				})
				clients.push(client)
				cleanup.defer(() => client.disconnect())
				return client
			},
		})
		for (const client of clients) {
			await client.ready
			await client.connect()
		}
		await use(harness)
		await harness.deactivateGatesAndSettle()
	},
})

describe("a latest-50 page of personal todos", () => {
	pageTest(
		"follows inserts, deletes, reorders, completions, and category changes made elsewhere",
		async ({ harness, chat }) => {
			const { client1: ada, client2: other } = harness
			const seedTx = chat.transact()
			for (let category = 0; category < 3; category++)
				seedTx.set("categories", {
					id: `cat${category}`,
					name: `Cat ${category}`,
				})
			for (let index = 0; index < 120; index++)
				for (const owner of ["ada", "bob"])
					seedTx.set("todos", {
						id: `${owner}-${index}`,
						ownerId: owner,
						categoryId: `cat${index % 3}`,
						done: index % 5 === 0,
						createdAt: index,
					})
			await chat.commit(seedTx)
			// The other client edits records it has, so it reads them all.
			other.subscribe({ collection: "todos" })
			other.subscribe({ collection: "categories" })
			await expectQuery(other, { collection: "todos" }).toResolveTo(
				await chat.query({ collection: "todos" }),
			)
			const subscription = ada.subscribe(page)
			const settled = async () =>
				await expectQuery(ada, page).toResolveTo(await chat.query(page))
			await settled()
			expect(ada.query(page)).toHaveLength(50)

			const edit = async (
				write: (tx: ReturnType<typeof other.transact>) => void,
			) => {
				const tx = other.transact()
				write(tx)
				await (
					await other.commit(tx)
				).result
				await settled()
			}

			// Completing the newest todo replaces it with an unchanged older one.
			const shown = new Set(ada.query(page).map(({ id }) => id))
			await edit((tx) => tx.update("todos", "ada-119", { done: true }))
			const entered = ada.query(page).filter(({ id }) => !shown.has(id))
			expect(entered).toHaveLength(1)
			expect(entered[0]?.createdAt).toBeLessThan(
				Math.min(
					...ada
						.query(page)
						.slice(0, -1)
						.map(({ createdAt }) => createdAt),
				),
			)
			// A new todo enters at the top; a deleted one leaves.
			await edit((tx) =>
				tx.set("todos", {
					id: "ada-new",
					ownerId: "ada",
					categoryId: "cat0",
					done: false,
					createdAt: 1000,
				}),
			)
			await edit((tx) => tx.remove("todos", "ada-118"))
			// Moving an old todo to the top reorders the page.
			await edit((tx) => tx.update("todos", "ada-1", { createdAt: 2000 }))
			expect(ada.query(page)[0]?.id).toBe("ada-1")
			// A category move and a change to the related category both show.
			await edit((tx) => tx.update("todos", "ada-117", { categoryId: "cat2" }))
			await edit((tx) => tx.set("categories", { id: "cat2", name: "Renamed" }))
			expect(
				ada.query(page).find(({ id }) => id === "ada-117")?.category,
			).toEqual({ id: "cat2", name: "Renamed" })
			// Another owner's changes leave the page as it is.
			const before = ada.query(page)
			await edit((tx) => tx.update("todos", "bob-119", { createdAt: 5000 }))
			expect(ada.query(page)).toEqual(before)
			subscription.destroy()
		},
	)
})
