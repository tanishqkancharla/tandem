import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { tag } from "@tandem/types"
import { afterEach, expect, test } from "vitest"
import { JsonFileRemote } from "../src/JsonFileRemote"
import { createTestClient, thread, type TestsSchema } from "./fixtures"

const tempDirs: string[] = []

afterEach(async () => {
	await Promise.all(
		tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
	)
})

async function tempFilePath() {
	const dir = await mkdtemp(join(tmpdir(), "tandem-json-file-"))
	tempDirs.push(dir)
	return join(dir, "remote.json")
}

test("a new remote on the same file sees records written by the previous remote", async () => {
	const filePath = await tempFilePath()
	const first = new JsonFileRemote<TestsSchema>({ filePath })
	const writer = await createTestClient(first, "json-writer")

	await writer.connect()
	const tx = writer.transact()
	tx.set("threads", thread("thread-1", { title: "Persisted" }))
	await writer.commit(tx)
	await writer.disconnect()
	await first.destroy()

	const second = new JsonFileRemote<TestsSchema>({ filePath })
	const reader = await createTestClient(second, "json-reader")
	await reader.connect()
	const subscription = reader.subscribe({ collection: "threads" }, () => {})
	await reader.pullFromRemote()

	expect(reader.query({ collection: "threads" })).toEqual([
		thread("thread-1", { title: "Persisted" }),
	])

	subscription.destroy()
	await reader.disconnect()
	await second.destroy()
})

test("a hand-written JSON file of collection arrays is served on pull", async () => {
	const filePath = await tempFilePath()
	await writeFile(
		filePath,
		`${JSON.stringify(
			{
				threads: [thread("thread-1", { title: "From disk", createdAt: 2 })],
			},
			null,
			2,
		)}\n`,
	)

	const remote = new JsonFileRemote<TestsSchema>({ filePath })
	const client = await createTestClient(remote, "json-seeded")
	await client.connect()
	const subscription = client.subscribe({ collection: "threads" }, () => {})
	await client.pullFromRemote()

	expect(client.query({ collection: "threads" })).toEqual([
		thread("thread-1", { title: "From disk", createdAt: 2 }),
	])

	subscription.destroy()
	await client.disconnect()
	await remote.destroy()
})

test("invalid JSON in the file fails with a clear error", async () => {
	const filePath = await tempFilePath()
	await writeFile(filePath, "{")

	const remote = new JsonFileRemote<TestsSchema>({ filePath })
	await remote.connect({ clientId: tag("json-invalid"), poke() {} })

	await expect(
		remote.pull({
			clientId: tag("json-invalid"),
			scanWindow: [{ collection: "threads" }],
		}),
	).rejects.toThrow(`JsonFileRemote could not parse ${filePath} as JSON`)

	await remote.destroy()
})
