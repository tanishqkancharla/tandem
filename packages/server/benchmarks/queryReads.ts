/**
 * Records read and bytes sent for small-app sync, with and without indexes.
 *
 * pnpm --filter tandem-dst exec tsx ../packages/server/benchmarks/queryReads.ts \
 *   [clients=10] [todosPerClient=500]
 *
 * Each client pulls its latest 50 open todos with their category. Then one
 * client edits a todo, every client is poked, and every client pulls again.
 * Counts come from an in-memory adapter, so they compare plans rather than
 * predict any database's latency.
 */
import { collection, defineRelations, defineSchema } from "@tanishqkancharla/tandem-core"
import type { ClientId, Cookie, ScanWindow } from "@tanishqkancharla/tandem-core"
import { InMemoryTupleStorage } from "tuple-database"
import type { ScanStorageArgs, WriteOps } from "tuple-database"
import { TandemServer } from "../src/TandemServer.js"
import type {
	TandemServerStorageApi,
	TandemTuple,
} from "../src/storage/TandemServerStorage.js"

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

const clients = Number(process.argv[2] ?? 10)
const todosPerClient = Number(process.argv[3] ?? 500)

class CountingStorage implements TandemServerStorageApi<TodoSchema> {
	private readonly memory = new InMemoryTupleStorage()
	recordsRead = 0

	scan(args?: ScanStorageArgs) {
		const tuples = this.memory.scan(args) as TandemTuple<TodoSchema>[]
		this.recordsRead += tuples.filter(({ key }) => key[0] === "record").length
		return Promise.resolve(tuples)
	}

	commit(writes: WriteOps<TandemTuple<TodoSchema>>) {
		this.memory.commit(writes)
		return Promise.resolve()
	}

	close() {
		return Promise.resolve()
	}
}

const fields = ["id", "ownerId", "categoryId", "done", "createdAt", "text"] as const
const relations = defineRelations(
	defineSchema({
		categories: collection<Category>({ fields: ["id", "name"] }),
		todos: collection<Todo>({ fields: [...fields] }),
	}),
	({ one }) => ({
		todos: { category: one("categories", { from: "categoryId", to: "id" }) },
	}),
)

const page = (owner: string): ScanWindow<TodoSchema> => [
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

async function run(indexed: boolean) {
	const storage = new CountingStorage()
	const server = new TandemServer({
		schema: defineSchema({
			categories: collection<Category>({ fields: ["id", "name"] }),
			todos: collection<Todo>({
				fields: [...fields],
				...(indexed && {
					indexes: { byOwner: ["ownerId", "done", "createdAt"] },
				}),
			}),
		}),
		relations,
		storage,
	})
	const tx = server.transact()
	for (let category = 0; category < 5; category++)
		tx.set("categories", { id: `cat${category}`, name: `Category ${category}` })
	for (let client = 0; client < clients; client++)
		for (let index = 0; index < todosPerClient; index++)
			tx.set("todos", {
				id: `u${client}-${index}`,
				ownerId: `u${client}`,
				categoryId: `cat${index % 5}`,
				done: index % 4 === 0,
				createdAt: index,
				text: `Todo ${index} of user ${client}`,
			})
	await server.commit(tx)

	const cookies = new Map<string, Cookie>()
	const pullEveryone = async () => {
		storage.recordsRead = 0
		let bytes = 0
		for (let client = 0; client < clients; client++) {
			const clientId = `c${client}` as ClientId
			const pulled = await server.pull({
				clientId,
				cookie: cookies.get(clientId),
				scanWindow: page(`u${client}`),
			})
			if ("error" in pulled) throw new Error(pulled.message)
			cookies.set(clientId, pulled.cookie)
			bytes += JSON.stringify(pulled.patch).length
		}
		return { recordsRead: storage.recordsRead, bytes }
	}

	for (let client = 0; client < clients; client++)
		await server.connect({
			clientId: `c${client}` as ClientId,
			poke: () => Promise.resolve(),
		})
	const first = await pullEveryone()
	storage.recordsRead = 0
	const editTx = server.transact()
	editTx.set("todos", {
		id: `u3-${todosPerClient - 1}`,
		ownerId: "u3",
		categoryId: "cat1",
		done: false,
		createdAt: todosPerClient - 1,
		text: "Edited",
	})
	await server.commit(editTx)
	const commitReads = storage.recordsRead
	const next = await pullEveryone()
	await server.close()
	return { first, commitReads, next }
}

const rowsOf = (label: string, result: Awaited<ReturnType<typeof run>>) => [
	label,
	result.first.recordsRead,
	result.first.bytes,
	result.commitReads,
	result.next.recordsRead,
	result.next.bytes,
]

const results = [rowsOf("scan", await run(false)), rowsOf("index", await run(true))]
console.log(
	`${clients} clients x ${todosPerClient} todos, latest-50 page each, one edit\n`,
)
console.log(
	"plan  | first pulls: records read, bytes | commit: records read | next pulls: records read, bytes",
)
for (const row of results) console.log(row.join(" | "))
