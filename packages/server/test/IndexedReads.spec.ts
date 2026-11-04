import {
	collection,
	defineRelations,
	defineSchema,
	tag,
	type ClientId,
	type ScanWindow,
} from "@tanishqkancharla/tandem-core"
import type { ScanStorageArgs } from "tuple-database"
import { assert, expect, test } from "vitest"
import { TandemServer, type TandemTuple } from "../src/index.js"
import { TestTandemServerStorage } from "./TandemServerStorage.fixture.js"

type Category = { id: string; name: string }
type Todo = {
	id: string
	ownerId: string
	categoryId: string
	done: boolean
	createdAt: number
	text: string
}
type TodoSchema = { categories: Category; todos: Todo }

const fields = [
	"id",
	"ownerId",
	"categoryId",
	"done",
	"createdAt",
	"text",
] as const

function todoSchema(indexed: boolean) {
	return defineSchema({
		categories: collection<Category>({ fields: ["id", "name"] }),
		todos: collection<Todo>({
			fields: [...fields],
			...(indexed && {
				indexes: {
					byOwner: ["ownerId", "done", "createdAt"],
					byCategory: ["categoryId"],
				},
			}),
		}),
	})
}

const relations = defineRelations(todoSchema(false), ({ one, many }) => ({
	categories: { todos: many("todos", { from: "id", to: "categoryId" }) },
	todos: { category: one("categories", { from: "categoryId", to: "id" }) },
}))

/** Counts the record tuples storage returns. */
class CountingStorage extends TestTandemServerStorage<TodoSchema> {
	recordsRead = 0

	override async scan(
		args?: ScanStorageArgs,
	): Promise<TandemTuple<TodoSchema>[]> {
		const tuples = await super.scan(args)
		this.recordsRead += tuples.filter(({ key }) => key[0] === "record").length
		return tuples
	}
}

/** Ten clients' personal todos, `perClient` each, in five categories. */
async function seededServer(indexed: boolean, perClient: number) {
	const storage = new CountingStorage()
	const server = new TandemServer({
		schema: todoSchema(indexed),
		relations,
		storage,
	})
	const tx = server.transact()
	for (let category = 0; category < 5; category++)
		tx.set("categories", { id: `cat${category}`, name: `Category ${category}` })
	for (let client = 0; client < 10; client++)
		for (let index = 0; index < perClient; index++)
			tx.set("todos", {
				id: `u${client}-${index}`,
				ownerId: `u${client}`,
				categoryId: `cat${index % 5}`,
				done: index % 4 === 0,
				createdAt: index,
				text: `Todo ${index} of user ${client}`,
			})
	await server.commit(tx)
	return { server, storage }
}

/** The latest 50 open todos of one owner, with their category. */
const latestPage = (owner: string): ScanWindow<TodoSchema> => [
	{
		collection: "todos",
		where: [
			["ownerId", "=", owner],
			["done", "=", false],
		],
		order: [["createdAt", "desc"]],
		limit: 50,
		with: { category: { collection: "categories" } },
	},
]

test.for([
	{ perClient: 500, scanned: 5000 },
	{ perClient: 2000, scanned: 20000 },
])(
	"ten clients' latest-50 pages read their own rows through an index ($perClient todos each)",
	// The unindexed server reads every todo on each of its ten pulls.
	{ timeout: 60_000 },
	async ({ perClient, scanned }) => {
		const plain = await seededServer(false, perClient)
		const indexed = await seededServer(true, perClient)
		const pullAll = async ({ server, storage }: typeof plain) => {
			storage.recordsRead = 0
			const sizes: number[] = []
			for (let client = 0; client < 10; client++) {
				const pulled = await server.pull({
					clientId: tag<ClientId>(`c${client}`),
					scanWindow: latestPage(`u${client}`),
				})
				assert(!("error" in pulled))
				sizes.push(JSON.stringify(pulled.patch).length)
			}
			return { recordsRead: storage.recordsRead, sizes }
		}

		const withoutIndex = await pullAll(plain)
		const withIndex = await pullAll(indexed)

		// The same patches, and each pull's 50 todos plus categories.
		expect(withIndex.sizes).toEqual(withoutIndex.sizes)
		// Without an index every pull reads all todos and every category.
		expect(withoutIndex.recordsRead).toBe(10 * (scanned + 5))
		// With one, about 50 todos and their categories per pull.
		expect(withIndex.recordsRead).toBeLessThanOrEqual(10 * (50 + 5 + 2))
		await plain.server.close()
		await indexed.server.close()
	},
)

test("indexed pages stay correct as rows leave, enter, reorder, and change category", async () => {
	const { server } = await seededServer(true, 120)
	const page = (owner: string) =>
		server.query({
			collection: "todos",
			where: { ownerId: owner, done: false },
			orderBy: { createdAt: "desc" },
			limit: 50,
			with: { category: true },
		})
	const expected = async (owner: string) =>
		(await server.query({ collection: "todos", with: { category: true } }))
			.filter((todo) => todo.ownerId === owner && !todo.done)
			.sort((left, right) => right.createdAt - left.createdAt)
			.slice(0, 50)
	const edit = async (
		write: (tx: ReturnType<typeof server.transact>) => unknown,
	) => {
		const tx = server.transact()
		await write(tx)
		await server.commit(tx)
		expect(await page("u3")).toEqual(await expected("u3"))
	}

	// A row completing leaves the page; the next older row, unchanged, takes its place.
	await edit((tx) => tx.update("todos", "u3-119", { done: true }))
	// A new row enters at the top, and a deleted one leaves.
	await edit((tx) =>
		tx.set("todos", {
			id: "u3-new",
			ownerId: "u3",
			categoryId: "cat1",
			done: false,
			createdAt: 500,
			text: "New",
		}),
	)
	await edit((tx) => tx.remove("todos", "u3-118"))
	// Reordering by createdAt, a category move, and a related record's change.
	await edit((tx) => tx.update("todos", "u3-10", { createdAt: 1000 }))
	await edit((tx) => tx.update("todos", "u3-117", { categoryId: "cat4" }))
	await edit((tx) => tx.set("categories", { id: "cat4", name: "Renamed" }))
	await server.close()
})

test("a one-to-many include reads its children through an index on the join field", async () => {
	const { server, storage } = await seededServer(true, 500)
	storage.recordsRead = 0
	const categories = await server.query({
		collection: "categories",
		where: { id: "cat2" },
		with: { todos: { where: { ownerId: "u1" } } },
	})
	expect(categories[0]?.todos).toHaveLength(100)
	// One category, then cat2's 1,000 todos across owners, not all 5,000.
	expect(storage.recordsRead).toBe(1 + 1000)
	await server.close()
})
