import {
	collection,
	defineSchema,
	tag,
	type ClientId,
	type MutationId,
	type Patch,
	type ScanWindow,
} from "@tanishqkancharla/tandem-core"
import { assert, expect, test } from "vitest"
import { TandemServer } from "../src/index.js"
import { TestTandemServerStorage } from "./TandemServerStorage.fixture.js"

type Todo = {
	id: string
	title: string
	done: boolean
	meta?: unknown
}

type TodoSchema = { todos: Todo }

const schema = defineSchema({
	todos: collection<Todo>({ fields: ["id", "title", "done", "meta"] }),
})

const all: ScanWindow<TodoSchema> = [{ collection: "todos" }]
const open: ScanWindow<TodoSchema> = [
	{ collection: "todos", where: [["done", "=", false]] },
]
const clientId = tag<ClientId>("viewer")

function createServer(storage = new TestTandemServerStorage<TodoSchema>()) {
	return {
		server: new TandemServer({ schema, relations: {}, storage }),
		storage,
	}
}

async function write(server: TandemServer<TodoSchema, {}>, ...todos: Todo[]) {
	const tx = server.transact()
	for (const todo of todos) tx.set("todos", todo)
	await server.commit(tx)
}

const todo = (id: string, overrides: Partial<Todo> = {}): Todo => ({
	id,
	title: `Todo ${id}`,
	done: false,
	...overrides,
})

function setIds(patch: Patch<TodoSchema>) {
	return (patch.set ?? []).map(({ value }) => value.id)
}

function removeIds(patch: Patch<TodoSchema>) {
	return (patch.remove ?? []).map(({ id }) => id)
}

test("a recognized cookie receives only new and changed records and removals", async () => {
	const { server } = createServer()
	await write(server, todo("kept"), todo("edited"), todo("deleted"))
	const first = await server.pull({ clientId, scanWindow: all })
	assert(!("error" in first))
	expect(first.patch.reset).toBe(true)
	expect(setIds(first.patch)).toEqual(["deleted", "edited", "kept"])

	// One edit, one insert, and one delete reach the client; the unchanged record does not.
	await write(server, todo("edited", { title: "Edited" }), todo("added"))
	const removeTx = server.transact()
	removeTx.remove("todos", "deleted")
	await server.commit(removeTx)
	const next = await server.pull({
		clientId,
		cookie: first.cookie,
		scanWindow: all,
	})
	assert(!("error" in next))
	expect(next.patch.reset).toBeUndefined()
	expect(next.patch.set).toEqual([
		{ collection: "todos", value: todo("added") },
		{ collection: "todos", value: todo("edited", { title: "Edited" }) },
	])
	expect(removeIds(next.patch)).toEqual(["deleted"])
})

test("a pull with nothing new still acknowledges a mutation", async () => {
	const { server } = createServer()
	await write(server, todo("same"))
	const first = await server.pull({ clientId, scanWindow: all })
	assert(!("error" in first))

	// The client's write sets the value the server already has.
	await server.push({
		clientId,
		mutations: [
			{
				id: tag<MutationId>(1),
				ops: [{ type: "set", collection: "todos", value: todo("same") }],
			},
		],
	})
	const next = await server.pull({
		clientId,
		cookie: first.cookie,
		scanWindow: all,
	})
	assert(!("error" in next))
	expect(next).toMatchObject({
		patch: { set: [], remove: [] },
		lastMutationId: 1,
	})
	expect(next.cookie).not.toBe(first.cookie)
})

test("a subscription change sends rows new to the view once and removes rows no query still covers", async () => {
	const { server } = createServer()
	await write(server, todo("open-1"), todo("done-1", { done: true }))
	const first = await server.pull({ clientId, scanWindow: open })
	assert(!("error" in first))
	expect(setIds(first.patch)).toEqual(["open-1"])

	// A new, overlapping query adds the unchanged done row but not the row the client has.
	const widened = await server.pull({
		clientId,
		cookie: first.cookie,
		scanWindow: [...open, ...all],
	})
	assert(!("error" in widened))
	expect(setIds(widened.patch)).toEqual(["done-1"])
	expect(removeIds(widened.patch)).toEqual([])

	// Dropping the wide query removes only the row the remaining query does not cover.
	const narrowed = await server.pull({
		clientId,
		cookie: widened.cookie,
		scanWindow: open,
	})
	assert(!("error" in narrowed))
	expect(setIds(narrowed.patch)).toEqual([])
	expect(removeIds(narrowed.patch)).toEqual(["done-1"])
})

test("a retry with the cookie of a dropped response resets", async () => {
	const { server } = createServer()
	await write(server, todo("a"), todo("b"))
	const first = await server.pull({ clientId, scanWindow: all })
	assert(!("error" in first))

	// The client never receives this response, so it keeps the first cookie.
	await write(server, todo("b", { title: "Changed" }))
	const dropped = await server.pull({
		clientId,
		cookie: first.cookie,
		scanWindow: all,
	})
	assert(!("error" in dropped))
	expect(setIds(dropped.patch)).toEqual(["b"])

	// The retry cannot be diffed against the dropped view, so it resends everything.
	const retry = await server.pull({
		clientId,
		cookie: first.cookie,
		scanWindow: all,
	})
	assert(!("error" in retry))
	expect(retry.patch.reset).toBe(true)
	expect(retry.patch.set).toEqual([
		{ collection: "todos", value: todo("a") },
		{ collection: "todos", value: todo("b", { title: "Changed" }) },
	])
})

test("a restarted server resets a client that pulled from the previous instance", async () => {
	const storage = new TestTandemServerStorage<TodoSchema>()
	const { server } = createServer(storage)
	await write(server, todo("a"))
	const first = await server.pull({ clientId, scanWindow: all })
	assert(!("error" in first))

	const { server: restarted } = createServer(storage)
	const next = await restarted.pull({
		clientId,
		cookie: first.cookie,
		scanWindow: all,
	})
	assert(!("error" in next))
	expect(next.patch.reset).toBe(true)
	expect(setIds(next.patch)).toEqual(["a"])
})

test("a direct storage write without a notification reaches the next pull", async () => {
	const { server, storage } = createServer()
	await write(server, todo("a"), todo("b"))
	const first = await server.pull({ clientId, scanWindow: all })
	assert(!("error" in first))

	// Another process writes the record; this storage reports no change.
	await storage.commit({
		set: [
			{ key: ["record", "todos", "a"], value: todo("a", { title: "Outside" }) },
		],
	})
	const next = await server.pull({
		clientId,
		cookie: first.cookie,
		scanWindow: all,
	})
	assert(!("error" in next))
	expect(next.patch.set).toEqual([
		{ collection: "todos", value: todo("a", { title: "Outside" }) },
	])
})

test("value changes are detected through nested and runtime types, and key order is not a change", async () => {
	const { server } = createServer()
	const meta = (overrides: Record<string, unknown> = {}) => ({
		due: new Date(Date.UTC(2026, 10, 4)),
		tags: new Set(["a", "b"]),
		labels: new Map([["owner", "ada"]]),
		bytes: new Uint8Array([1, 2]),
		count: 10n,
		nested: { list: [1, { deep: true }], zero: 0 },
		...overrides,
	})
	await write(server, todo("a", { meta: meta() }))
	let cookie = await server
		.pull({ clientId, scanWindow: all })
		.then((response) => {
			assert(!("error" in response))
			return response.cookie
		})
	const pullAfter = async (value: unknown) => {
		await write(server, todo("a", { meta: value }))
		const response = await server.pull({ clientId, cookie, scanWindow: all })
		assert(!("error" in response))
		expect(response.patch.reset).toBeUndefined()
		cookie = response.cookie
		return setIds(response.patch)
	}

	// Equal values in new objects, with keys and set members in another order, stay out.
	expect(
		await pullAfter({
			nested: { zero: 0, list: [1, { deep: true }] },
			count: 10n,
			bytes: new Uint8Array([1, 2]),
			labels: new Map([["owner", "ada"]]),
			tags: new Set(["b", "a"]),
			due: new Date(Date.UTC(2026, 10, 4)),
		}),
	).toEqual([])

	// Each kind of change inside the value resends the record.
	for (const changed of [
		meta({ due: new Date(Date.UTC(2026, 10, 5)) }),
		meta({ tags: new Set(["a"]) }),
		meta({ labels: new Map([["owner", "grace"]]) }),
		meta({ bytes: new Uint8Array([1, 3]) }),
		meta({ count: 11n }),
		meta({ nested: { list: [1, { deep: false }], zero: 0 } }),
		meta({ nested: { list: [1, { deep: true }], zero: -0 } }),
		meta({ nested: { list: ["1", { deep: true }], zero: 0 } }),
		meta({ nested: { list: [1, { deep: true }], zero: 0, extra: undefined } }),
		meta({ title: "\uD800" }),
		meta({ title: "\uDBFF" }),
	])
		expect(await pullAfter(changed)).toEqual(["a"])

	// A value without a canonical form always resends.
	class Opaque {}
	expect(await pullAfter(new Opaque())).toEqual(["a"])
	expect(await pullAfter(new Opaque())).toEqual(["a"])
})

test("a one-record edit among 500 sends one record", async () => {
	const { server } = createServer()
	await write(
		server,
		...Array.from({ length: 500 }, (_, index) => todo(`todo-${index}`)),
	)
	const first = await server.pull({ clientId, scanWindow: all })
	assert(!("error" in first))
	expect(first.patch.set).toHaveLength(500)

	await write(server, todo("todo-250", { done: true }))
	const next = await server.pull({
		clientId,
		cookie: first.cookie,
		scanWindow: all,
	})
	assert(!("error" in next))
	expect(next.patch.set).toEqual([
		{ collection: "todos", value: todo("todo-250", { done: true }) },
	])
})
