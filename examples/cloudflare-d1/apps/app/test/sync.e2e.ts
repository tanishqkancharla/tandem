import { execSync } from "node:child_process"
import { Logger, TandemClient } from "@tanishqkancharla/tandem-core"
import { getTandemCoordinatorStats } from "@tanishqkancharla/tandem-cloudflare"
import {
	keepTandemClientConnected,
	TandemCoordinatorRemote,
} from "@tanishqkancharla/tandem-cloudflare/client"
import { afterEach, describe, expect, test, vi } from "vitest"
import { todoSchema, type Todo, type TodoSchema } from "../src/schema.js"
import { e2eEnvironment, recordEvidence } from "./environment.js"

const environment = e2eEnvironment()
const live = environment.mode === "live"
const run = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`
const cleanups: (() => Promise<void> | void)[] = []

afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

type Frame = { at: number; direction: "sent" | "received"; type: string }

function frameType(data: unknown) {
	const text = String(data)
	if (text.startsWith("tandem:")) return text
	return (JSON.parse(text) as { type: string }).type
}

type AppTarget = { url: string; appId: string; secret: string }
const firstApp: AppTarget = {
	url: environment.appUrl,
	appId: environment.appId,
	secret: environment.appSecret,
}
const secondApp: AppTarget = {
	url: environment.secondAppUrl,
	appId: environment.secondAppId,
	secret: environment.secondAppSecret,
}

async function api(
	app: AppTarget,
	method: string,
	path: string,
	body?: unknown,
) {
	const response = await fetch(`${app.url}${path}`, {
		method,
		headers: {
			authorization: `Bearer ${environment.accessKey}`,
			"content-type": "application/json",
		},
		body: body === undefined ? undefined : JSON.stringify(body),
	})
	return { status: response.status, body: (await response.json()) as never }
}

/** Rows read straight from the app's D1 database through its ordinary API. */
async function d1Todos(app: AppTarget = firstApp) {
	const { body } = await api(app, "GET", "/api/todos")
	return (
		body as { todos: { id: string; title: string; done: number }[] }
	).todos
		.filter((row) => row.id.startsWith(run))
		.map(({ id, title, done }) => ({ id, title, done: Boolean(done) }))
}

function stats(app: AppTarget = firstApp) {
	return getTandemCoordinatorStats({
		coordinatorUrl: environment.coordinatorUrl,
		appId: app.appId,
		secret: app.secret,
	})
}

/** A browser tab: a Tandem client syncing through the deployed coordinator. */
async function openClient(
	name: string,
	{
		app = firstApp,
		keepAliveInterval = 30_000,
	}: { app?: AppTarget; keepAliveInterval?: number | false } = {},
) {
	const frames: Frame[] = []
	const sockets: WebSocket[] = []
	const disconnects: { at: number; code: number }[] = []
	const fetchToken = async () => {
		const { body } = await api(app, "POST", "/api/token", {
			subject: `${run}-${name}`,
		})
		return body as { token: string; url: string }
	}
	const { url } = await fetchToken()
	class RecordingWebSocket extends WebSocket {
		constructor(socketUrl: string) {
			super(socketUrl)
			sockets.push(this)
			this.addEventListener("message", (event) =>
				frames.push({
					at: Date.now(),
					direction: "received",
					type: frameType(event.data),
				}),
			)
		}
		override send(data: string) {
			frames.push({ at: Date.now(), direction: "sent", type: frameType(data) })
			super.send(data)
		}
	}
	const remote = new TandemCoordinatorRemote<TodoSchema>({
		url,
		getToken: async () => (await fetchToken()).token,
		keepAliveInterval,
		WebSocket: RecordingWebSocket,
	})
	remote.onDisconnect((event) =>
		disconnects.push({ at: Date.now(), code: event.code }),
	)
	const client = new TandemClient<TodoSchema>({
		schema: todoSchema,
		remote,
		autoConnect: false,
		logger: new Logger({ sinks: [] }),
	})
	await client.ready
	await client.connect()
	const stop = keepTandemClientConnected(client, remote, { initialDelay: 200 })
	client.subscribe({ collection: "todos" })
	await client.pullFromRemote()
	cleanups.push(async () => {
		stop()
		await client.disconnect()
	})
	return {
		client,
		remote,
		frames,
		sockets,
		disconnects,
		todos: () =>
			client
				.query({ collection: "todos" })
				.filter((todo: Todo) => todo.id.startsWith(run))
				.map(({ id, title, done }) => ({ id, title, done })),
	}
}

const id = (name: string) => `${run}-${name}`

async function eventually(
	assertion: () => void | Promise<void>,
	timeout = 20_000,
) {
	await vi.waitFor(assertion, { timeout, interval: 100 })
}

describe(`Tandem coordinator end to end (${environment.mode})`, () => {
	test("two clients converge on inserts, updates, and deletes that live in D1", async () => {
		const alice = await openClient("alice")
		const bob = await openClient("bob")

		// Alice inserts; Bob receives it and D1 holds the row
		const insertTx = alice.client.transact()
		insertTx.set("todos", {
			id: id("milk"),
			title: "Buy milk",
			done: false,
			createdAt: Date.now(),
		})
		await alice.client.commit(insertTx)
		await eventually(() =>
			expect(bob.todos()).toEqual([
				{ id: id("milk"), title: "Buy milk", done: false },
			]),
		)
		expect(await d1Todos()).toEqual([
			{ id: id("milk"), title: "Buy milk", done: false },
		])

		// Bob completes it; Alice receives it
		const updateTx = bob.client.transact()
		updateTx.update("todos", id("milk"), (todo) => ({ ...todo, done: true }))
		await bob.client.commit(updateTx)
		await eventually(() =>
			expect(alice.todos()).toEqual([
				{ id: id("milk"), title: "Buy milk", done: true },
			]),
		)

		// Alice deletes it; Bob and D1 drop it
		const removeTx = alice.client.transact()
		removeTx.remove("todos", id("milk"))
		await alice.client.commit(removeTx)
		await eventually(() => expect(bob.todos()).toEqual([]))
		expect(await d1Todos()).toEqual([])
	})

	test("external D1 writes reach idle subscribers through invalidation, with no polling", async () => {
		const alice = await openClient("idle-alice", { keepAliveInterval: false })
		const bob = await openClient("idle-bob", { keepAliveInterval: false })
		await new Promise((resolve) => setTimeout(resolve, 500))
		const before = await stats()

		// While idle, neither client sends anything and the coordinator does no bridge work
		const idleMs = live ? 20_000 : 3_000
		const framesBefore = [alice.frames.length, bob.frames.length]
		await new Promise((resolve) => setTimeout(resolve, idleMs))
		expect([alice.frames.length, bob.frames.length]).toEqual(framesBefore)
		const afterIdle = await stats()
		if (afterIdle.instanceId === before.instanceId) {
			expect(afterIdle.bridgeRequests).toBe(before.bridgeRequests)
		}

		// A plain SQL write through the app's REST endpoint pokes both clients
		const startedAt = Date.now()
		const created = await api(firstApp, "POST", "/api/todos", {
			id: id("rest"),
			title: "From REST",
		})
		expect(created).toEqual({
			status: 201,
			body: { notifiedSockets: expect.any(Number) },
		})
		await eventually(() => {
			expect(alice.todos()).toEqual([
				{ id: id("rest"), title: "From REST", done: false },
			])
			expect(bob.todos()).toEqual([
				{ id: id("rest"), title: "From REST", done: false },
			])
		})
		recordEvidence({
			test: "invalidation-no-polling",
			idleMs,
			idleFrames: 0,
			convergedMs: Date.now() - startedAt,
			statsBefore: before,
			statsAfterIdle: afterIdle,
			aliceFrames: alice.frames,
			bobFrames: bob.frames,
		})
		await api(firstApp, "DELETE", `/api/todos/${id("rest")}`)
	})

	test("a client that misses pokes while disconnected converges after reconnecting", async () => {
		const alice = await openClient("reconnect-alice")

		// The network drops Alice's socket; writes and invalidations happen meanwhile
		alice.sockets.at(-1)!.close(4000, "simulated network loss")
		await api(firstApp, "POST", "/api/todos", {
			id: id("missed"),
			title: "Missed",
		})
		await api(firstApp, "PATCH", `/api/todos/${id("missed")}`, { done: true })

		// Reconnecting pulls the current D1 state
		await eventually(() =>
			expect(alice.todos()).toEqual([
				{ id: id("missed"), title: "Missed", done: true },
			]),
		)
		expect(alice.disconnects.length).toBe(1)
		expect(alice.sockets.length).toBe(2)
		await api(firstApp, "DELETE", `/api/todos/${id("missed")}`)
	})

	test("apps are isolated: data, pokes, and tokens", async () => {
		const first = await openClient("isolated-first")
		const second = await openClient("isolated-second", { app: secondApp })
		const secondStatsBefore = await stats(secondApp)

		// A write to the first app reaches only the first app's clients
		await api(firstApp, "POST", "/api/todos", {
			id: id("first-only"),
			title: "First only",
		})
		await eventually(() => expect(first.todos()).toHaveLength(1))
		await second.client.pullFromRemote()
		expect(second.todos()).toEqual([])
		expect(await d1Todos(secondApp)).toEqual([])
		const secondStatsAfter = await stats(secondApp)
		if (secondStatsAfter.instanceId === secondStatsBefore.instanceId) {
			expect(secondStatsAfter.pokes).toBe(secondStatsBefore.pokes)
		}

		// A token minted by the first app cannot open the second app's coordinator
		const { body } = await api(firstApp, "POST", "/api/token", {
			subject: id("intruder"),
		})
		const { token } = body as { token: string }
		const wsBase = environment.coordinatorUrl.replace(/^http/, "ws")
		for (const target of [
			`${wsBase}/apps/${secondApp.appId}/connect?clientId=intruder&token=${token}`,
			`${wsBase}/apps/${firstApp.appId}/connect?clientId=intruder&token=forged.${token.split(".")[1]}`,
		]) {
			const socket = new WebSocket(target)
			const outcome = await new Promise<string>((resolve) => {
				socket.addEventListener("open", () => resolve("open"))
				socket.addEventListener("error", () => resolve("rejected"))
			})
			expect(outcome).toBe("rejected")
		}

		// Unsigned invalidations and bridge calls are refused
		const invalidate = await fetch(
			`${environment.coordinatorUrl}/apps/${firstApp.appId}/invalidate`,
			{ method: "POST", body: "{}" },
		)
		expect(invalidate.status).toBe(401)
		const bridge = await fetch(`${firstApp.url}/tandem/bridge`, {
			method: "POST",
			body: JSON.stringify({ op: "scan", args: {} }),
		})
		expect(bridge.status).toBe(401)
		await api(firstApp, "DELETE", `/api/todos/${id("first-only")}`)
	})

	test.runIf(live)(
		"the coordinator hibernates with sockets open and resumes poking after waking",
		async () => {
			const alice = await openClient("hibernate-alice", {
				keepAliveInterval: 10_000,
			})
			const bob = await openClient("hibernate-bob", {
				keepAliveInterval: 10_000,
			})
			const initial = await alice.remote.stats(alice.client.clientId)

			// Stay idle except runtime-answered keepalive frames
			await new Promise((resolve) => setTimeout(resolve, 90_000))
			const nonKeepAlive = [...alice.frames, ...bob.frames].filter(
				(frame) =>
					frame.at > Date.now() - 90_000 && !frame.type.startsWith("tandem:"),
			)
			expect(nonKeepAlive).toEqual([])
			expect(alice.disconnects).toEqual([])
			expect(bob.disconnects).toEqual([])

			// A new instance answers on the same socket: memory was discarded, the socket was not
			const woken = await alice.remote.stats(alice.client.clientId)
			recordEvidence({
				test: "hibernation",
				initial,
				woken,
				sockets: [alice.sockets.length, bob.sockets.length],
				keepAliveFrames: alice.frames.filter((frame) =>
					frame.type.startsWith("tandem:"),
				).length,
			})
			expect(woken.instanceId).not.toBe(initial.instanceId)
			expect(woken.constructedAt).toBeGreaterThan(initial.constructedAt)
			expect(alice.sockets.length).toBe(1)

			// Pokes still reach both clients after waking
			await api(firstApp, "POST", "/api/todos", {
				id: id("after-wake"),
				title: "After wake",
			})
			await eventually(() => {
				expect(alice.todos()).toEqual([
					{ id: id("after-wake"), title: "After wake", done: false },
				])
				expect(bob.todos()).toEqual([
					{ id: id("after-wake"), title: "After wake", done: false },
				])
			})
			await api(firstApp, "DELETE", `/api/todos/${id("after-wake")}`)
		},
	)

	test.runIf(live && Boolean(environment.redeployCommand))(
		"clients reconnect and converge after the coordinator is redeployed",
		async () => {
			const alice = await openClient("redeploy-alice")
			const bob = await openClient("redeploy-bob")
			const before = await stats()

			// Redeploying restarts the object and closes its sockets
			execSync(environment.redeployCommand!, { stdio: "inherit" })
			await eventually(
				() => expect(alice.disconnects.length).toBeGreaterThan(0),
				120_000,
			)
			const insertTx = bob.client.transact()
			insertTx.set("todos", {
				id: id("redeployed"),
				title: "After deploy",
				done: false,
				createdAt: Date.now(),
			})
			await eventually(
				() => expect(bob.sockets.length).toBeGreaterThan(1),
				60_000,
			)
			await bob.client.commit(insertTx)
			await eventually(() =>
				expect(alice.todos()).toEqual([
					{ id: id("redeployed"), title: "After deploy", done: false },
				]),
			)
			const after = await stats()
			recordEvidence({
				test: "redeploy",
				before,
				after,
				aliceDisconnects: alice.disconnects,
			})
			expect(after.instanceId).not.toBe(before.instanceId)
			await api(firstApp, "DELETE", `/api/todos/${id("redeployed")}`)
		},
	)

	test("a modest idle fleet stays bounded and every client receives one invalidation", async () => {
		const count = 20
		const fleet = await Promise.all(
			Array.from({ length: count }, (_, index) =>
				openClient(`fleet-${index}`, { keepAliveInterval: false }),
			),
		)
		const connected = await stats()
		expect(connected.sockets).toBeGreaterThanOrEqual(count)

		// Idle: no client sends frames
		const idleMs = live ? 60_000 : 3_000
		const framesBefore = fleet.map((member) => member.frames.length)
		await new Promise((resolve) => setTimeout(resolve, idleMs))
		expect(fleet.map((member) => member.frames.length)).toEqual(framesBefore)

		// One external write converges every client
		const startedAt = Date.now()
		await api(firstApp, "POST", "/api/todos", {
			id: id("fleet"),
			title: "Fleet",
		})
		await eventually(() => {
			for (const member of fleet) expect(member.todos()).toHaveLength(1)
		}, 60_000)
		const convergedMs = Date.now() - startedAt
		const pokes = fleet.map(
			(member) =>
				member.frames.filter(
					(frame) => frame.type === "poke" && frame.at >= startedAt,
				).length,
		)
		const afterWrite = await stats()

		// Closing the fleet releases its sockets
		for (const cleanup of cleanups.splice(0)) await cleanup()
		await new Promise((resolve) => setTimeout(resolve, 1000))
		const released = await stats()
		recordEvidence({
			test: "idle-fleet",
			count,
			idleMs,
			convergedMs,
			pokes,
			connected,
			afterWrite,
			released,
		})
		expect(Math.min(...pokes)).toBeGreaterThanOrEqual(1)
		expect(released.sockets).toBeLessThanOrEqual(connected.sockets - count)
		await api(firstApp, "DELETE", `/api/todos/${id("fleet")}`)
	})
})
