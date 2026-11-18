import {
	collection,
	defineSchema,
	t,
	TandemClient,
	TandemClientMemoryStorage,
} from "@tanishqkancharla/tandem-core"

const schema = defineSchema({
	notes: collection({ id: t.id(), text: t.string() }),
})

/**
 * Commits a note, recreates the client on the same storage, and returns what
 * the new client reads. Runs bundled, with no test setup or polyfills.
 */
export async function runScenario() {
	const first = new TandemClient({
		schema,
		clientStorage: new TandemClientMemoryStorage({ name: "notes", schema }),
	})
	await first.ready
	const seen: unknown[] = []
	first.subscribe({ collection: "notes" }, (notes) => seen.push(notes))
	const tx = first.transact()
	tx.set("notes", { id: "1", text: "hello" })
	await first.commit(tx)
	await first.flushClientStorage()
	await first.close()

	const second = new TandemClient({
		schema,
		clientStorage: new TandemClientMemoryStorage({ name: "notes", schema }),
	})
	await second.ready
	const restored = second.query({ collection: "notes" })
	await second.close()
	return { seen: seen.at(-1), restored }
}
