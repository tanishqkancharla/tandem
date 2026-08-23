import {
	IndexedDbTupleStorage,
	TandemClient,
	collection,
	defineSchema,
	t,
} from "@tandem/core"

const silentLogger = {
	debug() {},
	info() {},
	warn() {},
	log() {},
	error() {},
	scope() {
		return silentLogger
	},
}

export const schema = defineSchema({
	todos: collection({
		id: t.id(),
		text: t.string(),
		complete: t.boolean(),
		createdAt: t.number(),
	}),
})

export type Todo = {
	id: string
	text: string
	complete: boolean
	createdAt: number
}

export const db = new TandemClient({
	schema,
	storage: new IndexedDbTupleStorage({
		dbName: "tandem-todo",
		schema,
	}),
	logger: silentLogger,
})

export const ready = db.ready.then(async () => {
	if (db.query({ collection: "todos" }).length > 0) return

	const seedTx = db.transact()
	seedTx.set("todos", {
		id: "welcome",
		text: "Build something with Tandem",
		complete: false,
		createdAt: Date.now(),
	})
	seedTx.set("todos", {
		id: "maui",
		text: "Style it with Maui color tokens",
		complete: true,
		createdAt: Date.now() - 1,
	})
	await db.commit(seedTx)
	await db.flushStorage()
})

export async function persist(transaction: ReturnType<typeof db.transact>) {
	await db.commit(transaction)
	await db.flushStorage()
}
