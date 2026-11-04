import fs from "node:fs/promises"
import http from "node:http"
import {
	TandemClient,
	Logger,
	tag,
	type ClientId,
	type MutationId,
} from "@tanishqkancharla/tandem-core"
import * as errore from "errore"
import { build } from "esbuild"
import { Miniflare } from "miniflare"
import { expect, test } from "vitest"
import { schema } from "../src/schema.js"
import { createRemote } from "../src/remote.js"

class SyncProxyError extends errore.createTaggedError({
	name: "SyncProxyError",
	message: "The test edge could not forward an HTTP request",
}) {}

async function startWorker() {
	const bundle = await build({
		entryPoints: ["src/index.ts"],
		bundle: true,
		write: false,
		format: "esm",
		platform: "neutral",
		mainFields: ["module", "main"],
		conditions: ["workerd", "worker"],
		external: ["node:*"],
	})
	const runtime = new Miniflare({
		modules: true,
		script: bundle.outputFiles[0].text,
		compatibilityDate: "2026-07-01",
		compatibilityFlags: ["nodejs_compat"],
		d1Databases: { DB: "cloudflare-example" },
		durableObjects: { SYNC: { className: "SyncObject", useSQLite: true } },
	})
	const db = await runtime.getD1Database("DB")
	await db.prepare(await fs.readFile("schema.sql", "utf8")).run()
	return { runtime, db }
}

test("two clients sync existing D1 rows over SSE and recover a disconnected view", async () => {
	const { runtime, db } = await startWorker()
	await using cleanup = new errore.AsyncDisposableStack()
	cleanup.defer(() => runtime.dispose())
	await db
		.prepare(
			"insert into tasks (id, text, done) values ('existing', 'From SQL', 0)",
		)
		.run()
	const url = (await runtime.ready).toString()
	const alice = new TandemClient({
		schema,
		remote: createRemote(url),
		logger: new Logger(),
	})
	const bob = new TandemClient({
		schema,
		remote: createRemote(url),
		logger: new Logger(),
	})
	cleanup.defer(() => alice.close())
	cleanup.defer(() => bob.close())
	alice.subscribe({ collection: "tasks" }, () => {})
	bob.subscribe({ collection: "tasks" }, () => {})
	await expect
		.poll(() => bob.query({ collection: "tasks" }))
		.toEqual([{ id: "existing", text: "From SQL", done: false }])
	const update = alice.transact()
	update.set("tasks", {
		id: "existing",
		text: "Edited through Tandem",
		done: true,
	})
	await alice.commit(update)
	await expect
		.poll(() => bob.query({ collection: "tasks" }))
		.toEqual([{ id: "existing", text: "Edited through Tandem", done: true }])
	expect(await db.prepare("select text, done from tasks").all()).toMatchObject({
		results: [{ text: "Edited through Tandem", done: 1 }],
	})
	await bob.disconnect()
	const remove = alice.transact()
	remove.remove("tasks", "existing")
	await alice.commit(remove)
	await bob.connect()
	await expect.poll(() => bob.query({ collection: "tasks" })).toEqual([])

	const malformed = await fetch(new URL("/api/tandem", url), {
		method: "POST",
		body: "not JSON",
	})
	expect(malformed.status).toBe(400)
}, 30_000)

// Put a real HTTP edge in front of the Worker and fail only the event route.
async function blockEventStream(upstream: URL) {
	const edge = http.createServer((request, response) => {
		if (request.url?.startsWith("/api/tandem/events")) {
			response.writeHead(503).end("Stream unavailable")
			return
		}
		const body: Buffer[] = []
		request.on("data", (chunk: Buffer) => body.push(chunk))
		request.on("end", () => {
			void fetch(new URL(request.url!, upstream), {
				method: request.method,
				headers: { "content-type": "application/json" },
				body: Buffer.concat(body),
			})
				.then(async (result) => {
					response.writeHead(result.status).end(await result.text())
				})
				.catch((cause) => {
					console.error(new SyncProxyError({ cause }))
					response.writeHead(502).end("Upstream failed")
				})
		})
	})
	await new Promise<void>((resolve) => edge.listen(0, "127.0.0.1", resolve))
	const address = edge.address()
	if (typeof address !== "object" || address === null)
		throw new Error("No edge address")
	return { edge, url: `http://127.0.0.1:${address.port}` }
}

test("confirms a writer's push without waiting for an unavailable SSE stream", async () => {
	const { runtime } = await startWorker()
	await using cleanup = new errore.AsyncDisposableStack()
	cleanup.defer(() => runtime.dispose())
	const { edge, url } = await blockEventStream(await runtime.ready)
	cleanup.defer(
		() =>
			new Promise<void>((resolve, reject) =>
				edge.close((error) => (error ? reject(error) : resolve())),
			),
	)
	const remote = createRemote(url)
	const clientId = tag<ClientId>("writer-without-sse")
	const acknowledgements: MutationId[] = []
	const disconnect = await remote.connect({
		clientId,
		poke: async () => {
			const response = await remote.pull({ clientId, scanWindow: [] })
			if ("error" in response) throw new Error(response.message)
			acknowledgements.push(response.lastMutationId)
		},
	})
	if (typeof disconnect !== "function") throw new Error(disconnect.message)
	cleanup.defer(disconnect)
	expect(
		await remote.push({
			clientId,
			mutations: [
				{
					id: tag<MutationId>(1),
					ops: [
						{
							type: "set",
							collection: "tasks",
							value: { id: "saved", text: "Saved without SSE", done: false },
						},
					],
				},
			],
		}),
	).toEqual({ ok: true })
	// The event route returns 503, and its fallback does not run for 60 seconds.
	await expect.poll(() => acknowledgements, { timeout: 2_000 }).toContain(1)
}, 30_000)
