import {
	createTandemClientToken,
	handleTandemBridgeRequest,
	notifyTandemCoordinator,
	TandemD1Storage,
} from "@tanishqkancharla/tandem-cloudflare"
import type { TodoSchema } from "./schema.js"

/** The parts of Cloudflare's D1 binding this Worker uses. */
type D1Statement = {
	bind(...values: unknown[]): D1Statement
	all(): Promise<{ results: unknown[] }>
	run(): Promise<{ meta: { changes: number } }>
}
type D1Database = {
	prepare(query: string): D1Statement
	batch(statements: D1Statement[]): Promise<unknown[]>
}

type Env = {
	DB: D1Database
	ASSETS?: { fetch(request: Request): Promise<Response> }
	/** This app's ID in the coordinator's TANDEM_APPS configuration. */
	APP_ID: string
	/** Coordinator origin, for example https://tandem-coordinator.example.workers.dev */
	COORDINATOR_URL: string
	/** Secret shared with the coordinator (wrangler secret put TANDEM_SECRET). */
	TANDEM_SECRET: string
	/** Demo-only access key guarding token issue and REST writes. */
	DEMO_ACCESS_KEY: string
}

type ExecutionContext = { waitUntil(promise: Promise<unknown>): void }

function json(status: number, body: unknown) {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json" },
	})
}

function storageFor(env: Env) {
	return new TandemD1Storage<TodoSchema>({
		db: env.DB,
		collections: {
			todos: {
				table: "todos",
				columns: {
					id: "text",
					title: "text",
					done: "boolean",
					createdAt: "integer",
				},
			},
		},
	})
}

function authorized(request: Request, env: Env) {
	const header = request.headers.get("authorization") ?? ""
	return (
		env.DEMO_ACCESS_KEY.length > 0 && header === `Bearer ${env.DEMO_ACCESS_KEY}`
	)
}

function isTitle(value: unknown): value is string {
	return typeof value === "string" && value.length > 0 && value.length <= 500
}

/** Plain-SQL writes from ordinary app endpoints, followed by an explicit invalidation. */
async function afterExternalWrite(env: Env) {
	const notified = await notifyTandemCoordinator({
		coordinatorUrl: env.COORDINATOR_URL,
		appId: env.APP_ID,
		secret: env.TANDEM_SECRET,
	}).catch((error: unknown) => {
		// Clients converge on their next pull, commit, or reconnect.
		console.error("Tandem invalidation failed", error)
		return { sockets: -1 }
	})
	return notified.sockets
}

async function handleApi(request: Request, env: Env, url: URL) {
	if (!authorized(request, env)) return json(401, { error: "unauthorized" })

	if (url.pathname === "/api/token" && request.method === "POST") {
		// A real app derives the subject from its own session.
		const body = (await request.json().catch(() => ({}))) as {
			subject?: unknown
		}
		const subject =
			typeof body.subject === "string" && /^[\w-]{1,64}$/.test(body.subject)
				? body.subject
				: crypto.randomUUID()
		const token = await createTandemClientToken({
			appId: env.APP_ID,
			secret: env.TANDEM_SECRET,
			subject,
			ttlMs: 10 * 60_000,
		})
		const coordinator = new URL(env.COORDINATOR_URL)
		coordinator.protocol = coordinator.protocol === "http:" ? "ws:" : "wss:"
		coordinator.pathname = `/apps/${env.APP_ID}`
		return json(200, { token, subject, url: coordinator.toString() })
	}

	if (url.pathname === "/api/todos" && request.method === "GET") {
		const { results } = await env.DB.prepare(
			`SELECT id, title, done, createdAt FROM todos ORDER BY createdAt, id`,
		).all()
		return json(200, { todos: results })
	}

	if (url.pathname === "/api/todos" && request.method === "POST") {
		const body = (await request.json().catch(() => ({}))) as {
			id?: unknown
			title?: unknown
		}
		if (typeof body.id !== "string" || !/^[\w-]{1,64}$/.test(body.id))
			return json(400, { error: "invalid id" })
		if (!isTitle(body.title)) return json(400, { error: "invalid title" })
		await env.DB.prepare(
			`INSERT INTO todos (id, title, done, createdAt) VALUES (?, ?, 0, ?)`,
		)
			.bind(body.id, body.title, Date.now())
			.run()
		return json(201, { notifiedSockets: await afterExternalWrite(env) })
	}

	const match = /^\/api\/todos\/([\w-]{1,64})$/.exec(url.pathname)
	if (match && request.method === "PATCH") {
		const body = (await request.json().catch(() => ({}))) as {
			title?: unknown
			done?: unknown
		}
		if (body.title !== undefined && !isTitle(body.title))
			return json(400, { error: "invalid title" })
		if (body.done !== undefined && typeof body.done !== "boolean")
			return json(400, { error: "invalid done" })
		const result = await env.DB.prepare(
			`UPDATE todos SET title = COALESCE(?, title), done = COALESCE(?, done) WHERE id = ?`,
		)
			.bind(
				body.title ?? null,
				body.done === undefined ? null : Number(body.done),
				match[1],
			)
			.run()
		if (!result.meta.changes) return json(404, { error: "not found" })
		return json(200, { notifiedSockets: await afterExternalWrite(env) })
	}
	if (match && request.method === "DELETE") {
		await env.DB.prepare(`DELETE FROM todos WHERE id = ?`).bind(match[1]).run()
		return json(200, { notifiedSockets: await afterExternalWrite(env) })
	}
	return json(404, { error: "not found" })
}

export default {
	fetch(request: Request, env: Env, _ctx: ExecutionContext) {
		const url = new URL(request.url)
		if (url.pathname === "/tandem/bridge") {
			return handleTandemBridgeRequest(request, {
				appId: env.APP_ID,
				secret: env.TANDEM_SECRET,
				storage: storageFor(env),
				collections: ["todos"],
			})
		}
		if (url.pathname.startsWith("/api/")) return handleApi(request, env, url)
		if (env.ASSETS) return env.ASSETS.fetch(request)
		return Promise.resolve(json(404, { error: "not found" }))
	},
}
