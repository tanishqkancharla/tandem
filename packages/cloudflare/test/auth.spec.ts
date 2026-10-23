import { describe, expect, test } from "vitest"
import { signTandemRequest } from "../src/signing.js"
import {
	createTandemClientToken,
	createTandemCoordinator,
	notifyTandemCoordinator,
} from "../src/index.js"
import { createApp, secret } from "./fixtures.js"

const otherSecret = "another-secret-with-at-least-32-characters"

function coordinatorEnv(onObjectRequest: (request: Request) => Response) {
	return {
		TANDEM_APPS: JSON.stringify({
			"todo-app": { bridgeUrl: "https://app.example/bridge", secret },
			"other-app": {
				bridgeUrl: "https://other.example/bridge",
				secret: otherSecret,
			},
		}),
		TANDEM_COORDINATOR: {
			idFromName: (name: string) => name,
			get: (id: string) => ({
				fetch: (request: Request) =>
					Promise.resolve(
						onObjectRequest(
							new Request(request, {
								headers: {
									...Object.fromEntries(request.headers),
									"x-object": id,
								},
							}),
						),
					),
			}),
		},
	}
}

function upgrade(url: string) {
	return new Request(url, { headers: { upgrade: "websocket" } })
}

describe("coordinator Worker authentication", () => {
	const { worker } = createTandemCoordinator()
	const reached: Request[] = []
	const env = coordinatorEnv((request) => {
		reached.push(request)
		return Response.json({ ok: true, object: request.headers.get("x-object") })
	})

	test("WebSocket upgrades need a valid token for the requested app", async () => {
		const valid = await createTandemClientToken({
			appId: "todo-app",
			secret,
			subject: "alice",
		})
		const foreign = await createTandemClientToken({
			appId: "other-app",
			secret: otherSecret,
			subject: "alice",
		})
		const expired = await createTandemClientToken({
			appId: "todo-app",
			secret,
			subject: "alice",
			ttlMs: -1,
		})
		const forged = await createTandemClientToken({
			appId: "todo-app",
			secret: otherSecret,
			subject: "alice",
		})
		const base = "https://coordinator.example/apps"

		// Bad, foreign, expired, and forged tokens, and unknown apps, never reach an object
		for (const url of [
			`${base}/todo-app/connect?clientId=c1&token=garbage`,
			`${base}/todo-app/connect?clientId=c1&token=${foreign}`,
			`${base}/todo-app/connect?clientId=c1&token=${expired}`,
			`${base}/todo-app/connect?clientId=c1&token=${forged}`,
			`${base}/missing-app/connect?clientId=c1&token=${valid}`,
		]) {
			expect((await worker.fetch(upgrade(url), env)).status).toBe(401)
		}
		expect(
			(
				await worker.fetch(
					upgrade(`${base}/todo-app/connect?clientId=bad%20id&token=${valid}`),
					env,
				)
			).status,
		).toBe(400)
		expect(reached).toHaveLength(0)

		// A valid token reaches only that app's object
		const accepted = await worker.fetch(
			upgrade(`${base}/todo-app/connect?clientId=c1&token=${valid}`),
			env,
		)
		expect(await accepted.json()).toEqual({ ok: true, object: "app:todo-app" })
	})

	test("invalidations must be signed by the app's secret", async () => {
		reached.length = 0
		const url = "https://coordinator.example/apps/todo-app/invalidate"
		const body = "{}"

		// Unsigned, foreign-signed, and stale requests are rejected
		const foreign = await signTandemRequest({
			purpose: "invalidate",
			appId: "todo-app",
			secret: otherSecret,
			body,
		})
		const stale = await signTandemRequest({
			purpose: "invalidate",
			appId: "todo-app",
			secret,
			body,
			now: Date.now() - 10 * 60_000,
		})
		const bridgeSignature = await signTandemRequest({
			purpose: "bridge",
			appId: "todo-app",
			secret,
			body,
		})
		for (const headers of [{}, foreign, stale, bridgeSignature]) {
			const response = await worker.fetch(
				new Request(url, { method: "POST", headers, body }),
				env,
			)
			expect(response.status).toBe(401)
		}
		expect(reached).toHaveLength(0)

		// The app's helper signs correctly
		await notifyTandemCoordinator({
			coordinatorUrl: "https://coordinator.example",
			appId: "todo-app",
			secret,
			fetch: (input, init) => worker.fetch(new Request(input, init), env),
		})
		expect(reached).toHaveLength(1)
	})
})

describe("app bridge", () => {
	async function signedBridgeRequest(body: unknown, signingSecret = secret) {
		const text = JSON.stringify(body)
		return new Request("https://app.example/tandem/bridge", {
			method: "POST",
			headers: await signTandemRequest({
				purpose: "bridge",
				appId: "todo-app",
				secret: signingSecret,
				body: text,
			}),
			body: text,
		})
	}
	const ack = (clientId: string, lastMutationId: number) => ({
		key: ["client", clientId],
		value: { lastMutationId },
	})
	const record = (id: string) => ({
		key: ["record", "todos", id],
		value: { id, title: id, done: false, createdAt: 1 },
	})

	test("rejects unsigned and foreign requests", async () => {
		const app = createApp()
		const unsigned = new Request("https://app.example/tandem/bridge", {
			method: "POST",
			body: JSON.stringify({ op: "describe" }),
		})
		expect((await app.bridge(unsigned)).status).toBe(401)
		const foreign = await signedBridgeRequest({ op: "describe" }, otherSecret)
		expect((await app.bridge(foreign)).status).toBe(401)
	})

	test("commits only synced collections with exactly one advancing acknowledgement", async () => {
		const app = createApp()

		// Unknown collections and commits without an acknowledgement are refused
		const unknown = await signedBridgeRequest({
			op: "commit",
			writes: {
				set: [
					ack("c1", 1),
					{ key: ["record", "secrets", "x"], value: { id: "x" } },
				],
			},
		})
		expect((await app.bridge(unknown)).status).toBe(400)
		const unacknowledged = await signedBridgeRequest({
			op: "commit",
			writes: { set: [record("a")] },
		})
		expect((await app.bridge(unacknowledged)).status).toBe(400)

		// The first mutation applies with its acknowledgement
		const commit = {
			op: "commit",
			writes: { set: [ack("c1", 1), record("a")] },
		}
		expect((await app.bridge(await signedBridgeRequest(commit))).status).toBe(
			200,
		)

		// Replaying it, or skipping ahead, changes nothing
		app.database.sql(`DELETE FROM todos`)
		expect((await app.bridge(await signedBridgeRequest(commit))).status).toBe(
			409,
		)
		const skipped = {
			op: "commit",
			writes: { set: [ack("c1", 3), record("b")] },
		}
		expect((await app.bridge(await signedBridgeRequest(skipped))).status).toBe(
			409,
		)
		expect(app.todos()).toEqual([])
		expect(app.database.sql(`SELECT * FROM tandem_clients`)).toEqual([
			{ client_id: "c1", last_mutation_id: 1 },
		])
	})
})
