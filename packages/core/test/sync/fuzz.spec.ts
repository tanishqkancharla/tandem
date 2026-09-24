import { GatekeeperError, type CallHandle } from "@tanishqkancharla/gatekeeper"
import {
	type LoggerApi,
	type RemoteApi,
	TandemClient,
} from "@tanishqkancharla/tandem-core"
import type { TandemServer } from "@tanishqkancharla/tandem-server"
import * as errore from "errore"
import { describe, expect } from "vitest"
import {
	buildTimerGatekeeperHarness,
	test,
	todo,
	type DemoRng,
	type TestsSchema,
	type TestsTodo,
} from "../fixtures.js"

type Server = Pick<TandemServer<TestsSchema, {}>, "query">

type ClientName = "client1" | "client2"
type TodoId = "a" | "b"
type Op =
	| { id: TodoId; type: "set"; text: string }
	| { id: TodoId; type: "remove" }
type Live = {
	clientName: ClientName
	op?: Op
	call: CallHandle<void>
}

function createTimerGatekeeper({
	server,
	logger,
	rng,
}: {
	server: RemoteApi<TestsSchema>
	logger: LoggerApi
	rng: DemoRng
}) {
	const clients: TandemClient<TestsSchema>[] = []
	const gatekeeper = buildTimerGatekeeperHarness({
		server,
		createClient: (remote, label, timer) => {
			const client = new TandemClient<TestsSchema>({
				remote,
				logger,
				rng: rng.create(label),
				syncInterval: timer,
				autoConnect: false,
			})
			clients.push(client)
			return client
		},
	})
	return { clients, gatekeeper }
}

type TimerHarness = ReturnType<typeof createTimerGatekeeper>["gatekeeper"]

function mulberry32(seed: number) {
	let state = seed >>> 0
	return () => {
		state = (state + 0x6d2b79f5) >>> 0
		let value = state
		value = Math.imul(value ^ (value >>> 15), value | 1)
		value ^= value + Math.imul(value ^ (value >>> 7), value | 61)
		return ((value ^ (value >>> 14)) >>> 0) / 4294967296
	}
}

function settled(records: Iterable<TestsTodo>) {
	return [...records].sort((left, right) => left.id.localeCompare(right.id))
}

function applyShadow(shadow: Map<TodoId, TestsTodo>, op: Op) {
	if (op.type === "set") {
		shadow.set(op.id, todo(op.id, { text: op.text }))
		return
	}
	shadow.delete(op.id)
}

function readGate(call: CallHandle<void>, clientName: ClientName) {
	const timerName = `${clientName}Timer`
	try {
		call.assertCompleted()
		return "completed" as const
	} catch (error) {
		if (!(error instanceof GatekeeperError)) throw error
	}
	try {
		call.assertSentBy(timerName).assertWaitingFor(clientName)
		return "timer" as const
	} catch (error) {
		if (!(error instanceof GatekeeperError)) throw error
	}
	try {
		call.assertSentBy(clientName).assertWaitingFor("server")
		return "server" as const
	} catch (error) {
		if (!(error instanceof GatekeeperError)) throw error
	}
	call.assertSentBy("server").assertWaitingFor(clientName)
	return "ack" as const
}

async function step(live: Live, shadow: Map<TodoId, TestsTodo>) {
	const gate = readGate(live.call, live.clientName)
	if (gate === "completed") return
	if (gate === "timer") {
		await live.call.continueTo(live.clientName)
		return
	}
	if (gate === "server") {
		await live.call.continueTo("server")
		if (live.op) applyShadow(shadow, live.op)
		return
	}
	await live.call.continueTo(live.clientName)
}

async function deliver(live: Live, shadow: Map<TodoId, TestsTodo>) {
	for (let guard = 0; guard < 6; guard += 1) {
		if (readGate(live.call, live.clientName) === "completed") {
			await live.call.result
			return
		}
		await step(live, shadow)
	}
	throw new Error(`${live.clientName} call did not complete`)
}

async function start(
	harness: TimerHarness,
	clientName: ClientName,
	random: () => number,
	text: string,
): Promise<Live> {
	const client = harness[clientName]
	if (random() < 0.5) {
		return { clientName, call: await client.pullFromRemote() }
	}

	const id: TodoId = random() < 0.5 ? "a" : "b"
	const present = client
		.query({ collection: "todos" })
		.some((record: TestsTodo) => record.id === id)
	const op: Op =
		present && random() < 0.5
			? { id, type: "remove" }
			: { id, type: "set", text }
	const tx = client.transact()
	if (op.type === "set") tx.set("todos", todo(op.id, { text: op.text }))
	else tx.remove("todos", op.id)
	return { clientName, op, call: await client.commit(tx) }
}

async function runSeed(seed: number, harness: TimerHarness, server: Server) {
	const random = mulberry32(seed)
	const shadow = new Map<TodoId, TestsTodo>()
	const live = new Map<ClientName, Live>()

	for (let stepIndex = 0; stepIndex < 12; stepIndex += 1) {
		const clientName: ClientName = random() < 0.5 ? "client1" : "client2"
		const current = live.get(clientName)
		if (current) {
			await step(current, shadow)
			if (readGate(current.call, clientName) === "completed") {
				await current.call.result
				live.delete(clientName)
			}
			continue
		}
		live.set(
			clientName,
			await start(harness, clientName, random, `${seed}-${stepIndex}`),
		)
	}

	for (const pending of live.values()) await deliver(pending, shadow)

	for (const clientName of ["client1", "client2"] as const) {
		await deliver(
			{ clientName, call: await harness[clientName].pullFromRemote() },
			shadow,
		)
	}

	const expected = settled(shadow.values())
	expect(settled(harness.client1.query({ collection: "todos" }))).toEqual(
		expected,
	)
	expect(settled(harness.client2.query({ collection: "todos" }))).toEqual(
		expected,
	)
	expect(settled(await server.query({ collection: "todos" }))).toEqual(expected)
}

describe("Tandem client sync fuzz", () => {
	test("replays seeded edits and pulls onto one document", async ({
		makeRemote,
		logger,
		rng,
	}) => {
		for (const seed of [1, 2, 3]) {
			const server = makeRemote()
			const { clients, gatekeeper } = createTimerGatekeeper({
				server,
				logger,
				rng,
			})
			await using cleanup = new errore.AsyncDisposableStack()
			await using harness = gatekeeper

			for (const client of clients) {
				await client.ready
				await client.connect()
				// Pull only returns records inside the scan window. Subscribing once
				// before the draws keeps that window open. The loop does not subscribe.
				const subscription = client.subscribe({ collection: "todos" })
				cleanup.defer(() => {
					subscription.destroy()
					return client.disconnect()
				})
			}

			await harness.activateGates()
			await runSeed(seed, harness, server)
			await harness.deactivateGatesAndSettle()
		}
	})
})
