import {
	InMemoryTupleStorage,
	TupleDatabase,
	TupleDatabaseClient,
} from "tuple-database"
import { expect, test } from "vitest"
import { collection, defineSchema } from "../schema/Schema.js"
import { schemaIndexes, TupleDatabaseWithIndexes } from "./indexes.js"

type Todo = { id: string; owner: string; rank: number }

const indexes = schemaIndexes(
	defineSchema({
		todos: collection<Todo>({
			fields: ["id", "owner", "rank"],
			indexes: { byOwner: ["owner", "rank"] },
		}),
	}),
)

function database() {
	return new TupleDatabaseClient(
		new TupleDatabaseWithIndexes({
			database: new TupleDatabase(new InMemoryTupleStorage()),
			indexes,
		}),
	)
}

const entries = (db: ReturnType<typeof database>) =>
	db.scan({ prefix: ["index"] }).map(({ key }) => key)

test("a commit that removes and sets one record keeps the entry for its final value", () => {
	const db = database()
	const key = ["record", "todos", "t1"]
	db.commit({ set: [{ key, value: { id: "t1", owner: "ada", rank: 1 } }] })

	// Storage applies removals first, so the set wins, with or without a new entry.
	db.commit({
		remove: [key],
		set: [{ key, value: { id: "t1", owner: "ada", rank: 1 } }],
	})
	expect(entries(db)).toEqual([["index", "todos", "byOwner", "ada", 1, "t1"]])
	db.commit({
		remove: [key],
		set: [{ key, value: { id: "t1", owner: "bob", rank: 2 } }],
	})
	expect(entries(db)).toEqual([["index", "todos", "byOwner", "bob", 2, "t1"]])

	// Two sets of one key leave only the later value's entry.
	db.commit({
		set: [
			{ key, value: { id: "t1", owner: "cy", rank: 3 } },
			{ key, value: { id: "t1", owner: "dee", rank: 4 } },
		],
	})
	expect(entries(db)).toEqual([["index", "todos", "byOwner", "dee", 4, "t1"]])
})
