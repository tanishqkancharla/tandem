import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { collection, defineSchema } from "@tanishqkancharla/tandem-core"
import {
	TandemServer,
	TandemServerJsonFileStorage,
} from "@tanishqkancharla/tandem-server"
import { expect, test as baseTest } from "vitest"

type SessionEntry = {
	id: readonly [sessionId: string, namespace: string, sequence: number]
	body: string
}

type SessionSchema = {
	entries: SessionEntry
}

const schema = defineSchema({
	entries: collection<SessionEntry>({ fields: ["id", "body"] }),
})

const test = baseTest.extend<{ filePath: string }>({
	filePath: async ({}, use) => {
		const directory = await fs.mkdtemp(
			path.join(os.tmpdir(), "tandem-compound-ids-e2e-"),
		)
		await use(path.join(directory, "nested", "tandem.json"))
		await fs.rm(directory, { recursive: true, force: true })
	},
})

function createServer(filePath: string) {
	return new TandemServer({
		schema,
		relations: {},
		storage: new TandemServerJsonFileStorage<SessionSchema>({ filePath }),
	})
}

test("compound IDs remain queryable across durable server restarts", async ({
	filePath,
}) => {
	const firstServer = createServer(filePath)
	const createTx = firstServer.transact()
	createTx.set("entries", {
		id: ["session-2", "messages", 1],
		body: "Other session",
	})
	createTx.set("entries", {
		id: ["session-1", "messages", 2],
		body: "Second",
	})
	createTx.set("entries", {
		id: ["session-1", "messages", 1],
		body: "First",
	})
	createTx.set("entries", {
		id: ["session-1", "metadata", 1],
		body: "Metadata",
	})
	await firstServer.commit(createTx)
	await firstServer.close()

	const secondServer = createServer(filePath)
	const readTx = secondServer.transact()
	expect(
		await readTx.scan("entries", {
			prefix: ["session-1", "messages"],
		}),
	).toEqual([
		{ id: ["session-1", "messages", 1], body: "First" },
		{ id: ["session-1", "messages", 2], body: "Second" },
	])
	expect(
		await readTx.scan("entries", {
			prefix: ["session-1", "messages"],
			reverse: true,
			limit: 1,
		}),
	).toEqual([{ id: ["session-1", "messages", 2], body: "Second" }])
	expect(await readTx.get("entries", ["session-1", "metadata", 1])).toEqual({
		id: ["session-1", "metadata", 1],
		body: "Metadata",
	})
	await readTx.cancel()

	const updateTx = secondServer.transact()
	await updateTx.update("entries", ["session-1", "messages", 1], (entry) => ({
		...entry,
		body: "Updated",
	}))
	updateTx.remove("entries", ["session-1", "messages", 2])
	await secondServer.commit(updateTx)
	await secondServer.close()

	const thirdServer = createServer(filePath)
	const verifyTx = thirdServer.transact()
	expect(
		await verifyTx.scan("entries", {
			prefix: ["session-1", "messages"],
		}),
	).toEqual([{ id: ["session-1", "messages", 1], body: "Updated" }])
	await verifyTx.cancel()
	await thirdServer.close()
})
