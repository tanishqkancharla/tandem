import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import {
	collection,
	defineRelations,
	defineSchema,
	Logger,
	type MutationOp,
	type RemoteApi,
	TandemClient,
} from "@tanishqkancharla/tandem-core"
import {
	TandemServer,
	TandemServerJsonFileStorage,
	type TandemServerTransaction,
} from "@tanishqkancharla/tandem-server"
import {
	convertToModelMessages,
	type LanguageModel,
	readUIMessageStream,
	streamText,
	tool,
	toUIMessageStream,
	type UIMessage,
} from "ai"
import { MockLanguageModelV4, simulateReadableStream } from "ai/test"
import * as errore from "errore"
import { expect, test as baseTest, vi } from "vitest"
import { z } from "zod"

// The reference implementation of docs/agent-chat.md.

type Message = {
	id: string
	threadId: string
	role: "user" | "assistant"
	status: "streaming" | "complete" | "stopped" | "error"
	/** Orders the thread. A reply sorts right after its user message. */
	createdAt: number
	/** When the server last saved the message. A stale "streaming" reply failed. */
	updatedAt: number
}

type UIPart = UIMessage["parts"][number]

/** One part of a message, in its own record so each write stays small. */
type Part = {
	id: string
	threadId: string
	messageId: string
	/** The part's position in the message. */
	index: number
	/** A text or reasoning part's text. The server appends to it as it streams. */
	text: string
	/** The rest of the part, with `text` left empty. */
	part: UIPart
}

/** Client-owned controls for one reply. */
type Run = { id: string; stopRequested: boolean }

type ChatSchema = { messages: Message; parts: Part; runs: Run }

const schema = defineSchema({
	messages: collection<Message>({
		fields: ["id", "threadId", "role", "status", "createdAt", "updatedAt"],
	}),
	parts: collection<Part>({
		fields: ["id", "threadId", "messageId", "index", "text", "part"],
	}),
	runs: collection<Run>({ fields: ["id", "stopRequested"] }),
})

const relations = defineRelations(schema, ({ many }) => ({
	messages: { parts: many("parts", { from: "id", to: "messageId" }) },
}))

type ChatTandem = TandemServer<ChatSchema, typeof relations>

/** A thread's messages with their parts, in order. */
const threadQuery = (threadId: string) =>
	({
		collection: "messages",
		where: { threadId },
		orderBy: { createdAt: "asc" },
		with: { parts: { orderBy: { index: "asc" } } },
	}) as const

class ReplyError extends errore.createTaggedError({
	name: "ReplyError",
	message: "Reply $id failed",
}) {}

const replyId = (userMessageId: string) => `${userMessageId}:reply`

const isReplyId = (id: string) => id.endsWith(":reply")

const partId = (messageId: string, index: number) => `${messageId}:${index}`

function toPartRecord(
	message: Pick<Message, "id" | "threadId">,
	index: number,
	part: UIPart,
): Part {
	const hasText = "text" in part
	return {
		id: partId(message.id, index),
		threadId: message.threadId,
		messageId: message.id,
		index,
		text: hasText ? part.text : "",
		part: hasText ? { ...part, text: "" } : part,
	}
}

function fromPartRecord({ text, part }: Part): UIPart {
	return "text" in part ? { ...part, text } : part
}

/** Clients write runs and user messages with their parts. Reply IDs are reserved for the server. */
function isClientWrite(op: MutationOp<ChatSchema>) {
	if (op.collection === "runs") return op.type !== "remove"
	if (op.type !== "set") return false
	if (op.collection === "messages")
		return op.value.role === "user" && !isReplyId(op.value.id)
	return (
		!isReplyId(op.value.messageId) &&
		op.value.id === partId(op.value.messageId, op.value.index)
	)
}

/**
 * Writes what changed between two snapshots of a reply's parts: grown text as
 * an append, anything else as the whole part.
 */
function saveParts(
	tx: TandemServerTransaction<ChatSchema, typeof relations>,
	reply: Message,
	previous: UIPart[],
	parts: UIPart[],
) {
	parts.forEach((part, index) => {
		const next = toPartRecord(reply, index, part)
		const saved = previous[index] && toPartRecord(reply, index, previous[index])
		const grew =
			saved &&
			JSON.stringify(saved.part) === JSON.stringify(next.part) &&
			next.text.startsWith(saved.text)
		if (!grew) {
			tx.set("parts", next)
			return
		}
		const delta = next.text.slice(saved.text.length)
		if (delta) tx.append("parts", next.id, { text: delta })
	})
}

/** A crash leaves replies "streaming"; nothing will finish them now. */
async function failInterruptedReplies(tandem: ChatTandem) {
	const interrupted = await tandem.query({
		collection: "messages",
		where: { status: "streaming" },
	})
	if (!interrupted.length) return
	const tx = tandem.transact()
	for (const message of interrupted) {
		tx.set("messages", { ...message, status: "error", updatedAt: Date.now() })
	}
	await tandem.commit(tx)
}

class ChatServer {
	private readonly stopTimers = new Set<() => void>()
	private readonly replies = new Set<Promise<void>>()

	private constructor(
		readonly tandem: ChatTandem,
		private readonly model: LanguageModel,
	) {}

	static async start({
		filePath,
		model,
	}: {
		filePath: string
		model: LanguageModel
	}) {
		const tandem = new TandemServer({
			schema,
			relations,
			storage: new TandemServerJsonFileStorage<ChatSchema>({ filePath }),
		})
		await failInterruptedReplies(tandem)
		return new ChatServer(tandem, model)
	}

	/**
	 * The JSON transport a browser would use, with slow pull responses. It
	 * counts the pulls and live payloads it carries.
	 */
	remote({ pullLatency }: { pullLatency: number }) {
		const traffic = { pulls: 0, payloads: 0, appends: 0 }
		const overJson = <Value>(value: Value): Value =>
			JSON.parse(JSON.stringify(value)) as Value
		const remote: RemoteApi<ChatSchema> = {
			connect: (client) =>
				this.tandem.connect({
					...client,
					poke: (payload) => {
						if (payload) traffic.payloads += 1
						if (payload?.append) traffic.appends += 1
						return client.poke(payload && overJson(payload))
					},
				}),
			push: async (args) => {
				// Drop forbidden operations but keep each mutation, so the client's
				// next pull acknowledges it and restores the server's value. An error
				// response would leave the mutation pending and fail every later push.
				const mutations = overJson(args.mutations).map((mutation) => ({
					...mutation,
					ops: mutation.ops.filter(isClientWrite),
				}))
				const response = await this.tandem.push({ ...args, mutations })
				if ("error" in response) return response
				for (const { ops } of mutations) {
					for (const op of ops) {
						if (op.type === "set" && op.collection === "messages")
							this.startReply(op.value)
					}
				}
				return response
			},
			pull: async (args) => {
				traffic.pulls += 1
				const response = await this.tandem.pull(overJson(args))
				await new Promise((resolve) => setTimeout(resolve, pullLatency))
				return overJson(response)
			},
		}
		return { remote, traffic }
	}

	/** Waits for replies in flight, then closes storage. */
	async close() {
		await Promise.all(this.replies)
		await this.tandem.close()
	}

	/** Stops the process mid-reply: no more saves, no final status. */
	async crash() {
		for (const stop of this.stopTimers) stop()
		await this.tandem.close()
	}

	private startReply(userMessage: Message) {
		const reply = this.streamReply(userMessage).then((result) => {
			if (result instanceof Error) console.error(result)
		})
		this.replies.add(reply)
		void reply.then(() => this.replies.delete(reply))
	}

	private async streamReply(userMessage: Message) {
		const id = replyId(userMessage.id)
		const claimTx = this.tandem.transact()
		// A retried push must not start a second reply.
		if (await claimTx.get("messages", id)) return claimTx.cancel()
		const reply: Message = {
			id,
			threadId: userMessage.threadId,
			role: "assistant",
			status: "streaming",
			createdAt: userMessage.createdAt + 1,
			updatedAt: Date.now(),
		}
		claimTx.set("messages", reply)
		await this.tandem.commit(claimTx)

		// The server is the reply record's only writer, so each save sets it whole.
		const saveStatus = (status: Message["status"]) => {
			const tx = this.tandem.transact()
			tx.set("messages", { ...reply, status, updatedAt: Date.now() })
			return this.tandem.commit(tx)
		}
		// Clients treat a reply that stops saving for 15 seconds as failed.
		const heartbeat = setInterval(
			() => void saveStatus("streaming").catch(console.error),
			5_000,
		)
		const stopHeartbeat = () => clearInterval(heartbeat)
		this.stopTimers.add(stopHeartbeat)

		// The stop button writes the client-owned run record.
		const controller = new AbortController()
		const runs = await this.tandem.subscribe(
			{ collection: "runs", where: { id } },
			([run]) => {
				if (run?.stopRequested) controller.abort()
			},
		)
		if (runs.result[0]?.stopRequested) controller.abort()

		const thread = await this.tandem.query(threadQuery(userMessage.threadId))
		const result = streamText({
			model: this.model,
			messages: await convertToModelMessages(
				thread
					.filter((message) => message.id !== id)
					.map((message) => ({
						id: message.id,
						role: message.role,
						parts: message.parts.map(fromPartRecord),
					})),
			),
			tools: { weather },
			abortSignal: controller.signal,
		})

		const streamed = await (async () => {
			const messages = readUIMessageStream({
				stream: toUIMessageStream({ stream: result.stream }),
				terminateOnError: true,
			})
			let saved: UIPart[] = []
			for await (const message of messages) {
				const tx = this.tandem.transact()
				saveParts(tx, reply, saved, message.parts)
				saved = message.parts
				await this.tandem.commit(tx)
			}
		})().catch((cause) => new ReplyError({ id, cause }))

		stopHeartbeat()
		this.stopTimers.delete(stopHeartbeat)
		runs.destroy()
		if (streamed instanceof Error) {
			await saveStatus("error")
			return streamed
		}
		await saveStatus(controller.signal.aborted ? "stopped" : "complete")
	}
}

const weather = tool({
	description: "Get the weather in a city",
	inputSchema: z.object({ city: z.string() }),
	execute: ({ city }) => Promise.resolve({ city, forecast: "sunny" }),
})

type Snapshot = { text: string; status: Message["status"] }

function snapshotOf(message: Message & { parts: Part[] }): Snapshot {
	const text = message.parts.map(({ text }) => text).join("")
	return { text, status: message.status }
}

const usage = (outputTokens: number) => ({
	inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
	outputTokens: { total: outputTokens, text: outputTokens, reasoning: 0 },
})

function textModel(
	tokens: string[],
	{
		chunkDelayInMs = 2,
		failAfter,
	}: { chunkDelayInMs?: number; failAfter?: number } = {},
) {
	const deltas = tokens.map((delta) => ({
		type: "text-delta" as const,
		id: "text-1",
		delta,
	}))
	return new MockLanguageModelV4({
		doStream: () =>
			Promise.resolve({
				stream: simulateReadableStream({
					chunkDelayInMs,
					chunks: [
						{ type: "stream-start", warnings: [] },
						{ type: "text-start", id: "text-1" },
						...(failAfter === undefined
							? [
									...deltas,
									{ type: "text-end" as const, id: "text-1" },
									{
										type: "finish" as const,
										finishReason: { unified: "stop" as const, raw: "stop" },
										usage: usage(tokens.length),
									},
								]
							: [
									...deltas.slice(0, failAfter),
									{ type: "error" as const, error: new Error("Model failed") },
								]),
					],
				}),
			}),
	})
}

const test = baseTest.extend<{
	filePath: string
	/** A viewer of one thread, recording every distinct reply snapshot it shows. */
	viewer: (
		chat: ChatServer,
		threadId: string,
	) => Promise<{
		client: TandemClient<ChatSchema, typeof relations>
		seen: Snapshot[]
		traffic: { pulls: number; payloads: number; appends: number }
	}>
}>({
	filePath: async ({}, use) => {
		const directory = await fs.mkdtemp(
			path.join(os.tmpdir(), "tandem-agent-chat-"),
		)
		await use(path.join(directory, "tandem.json"))
		await fs.rm(directory, { recursive: true, force: true })
	},
	viewer: async ({}, use) => {
		await using cleanup = new errore.AsyncDisposableStack()
		await use(async (chat, threadId) => {
			const { remote, traffic } = chat.remote({ pullLatency: 15 })
			const client = new TandemClient<ChatSchema, typeof relations>({
				schema,
				relations,
				remote,
				logger: new Logger({ sinks: [] }),
				syncInterval: 0,
			})
			const seen: Snapshot[] = []
			const thread = client.subscribe(threadQuery(threadId), (messages) => {
				const reply = messages.find(({ role }) => role === "assistant")
				if (!reply) return
				const snapshot = snapshotOf(reply)
				if (JSON.stringify(snapshot) !== JSON.stringify(seen.at(-1)))
					seen.push(snapshot)
			})
			cleanup.defer(async () => {
				thread.destroy()
				await client.disconnect()
			})
			await client.ready
			await client.pullFromRemote()
			return { client, seen, traffic }
		})
	},
})

/** A user message and its one text part, sent in one commit. */
function sendMessage(
	client: TandemClient<ChatSchema, typeof relations>,
	text: string,
	{ id = "message-1", createdAt = 1 }: { id?: string; createdAt?: number } = {},
) {
	const message: Message = {
		id,
		threadId: "thread-1",
		role: "user",
		status: "complete",
		createdAt,
		updatedAt: createdAt,
	}
	const tx = client.transact()
	tx.set("messages", message)
	tx.set("parts", toPartRecord(message, 0, { type: "text", text }))
	return client.commit(tx)
}

test("every viewer sees a long reply only grow, with a bounded number of pulls", async ({
	filePath,
	viewer,
}) => {
	const tokens = Array.from({ length: 300 }, (_, index) => `w${index} `)
	const chat = await ChatServer.start({
		filePath,
		model: textModel(tokens, { chunkDelayInMs: 4 }),
	})
	const sender = await viewer(chat, "thread-1")
	const friend = await viewer(chat, "thread-1")
	const before = [sender, friend].map(({ traffic }) => ({ ...traffic }))

	const startedAt = Date.now()
	await sendMessage(sender.client, "Count to 300")
	const final = { text: tokens.join(""), status: "complete" }
	await vi.waitFor(
		() => {
			expect(sender.seen.at(-1)).toEqual(final)
			expect(friend.seen.at(-1)).toEqual(final)
		},
		{ timeout: 10_000 },
	)
	const seconds = (Date.now() - startedAt) / 1_000
	await chat.close()

	for (const [index, { seen, traffic }] of [sender, friend].entries()) {
		// The text only grows, while streaming, then completes.
		for (const [step, snapshot] of seen.slice(1).entries())
			expect(snapshot.text.startsWith(seen[step]!.text)).toBe(true)
		expect(
			seen.slice(0, -1).every(({ status }) => status === "streaming"),
		).toBe(true)
		// Hundreds of appends reach each viewer in a few payloads per second
		// and about one pull per second, not one of each per token.
		const pulls = traffic.pulls - before[index]!.pulls
		const payloads = traffic.payloads - before[index]!.payloads
		expect(seen.length).toBeGreaterThan(3)
		expect(traffic.appends).toBeGreaterThan(0)
		expect(pulls).toBeLessThanOrEqual(Math.ceil(seconds) + 3)
		expect(payloads).toBeLessThanOrEqual(Math.ceil(seconds * 20) + 3)
	}
})

test("a tool call shows as a part that changes in place between text parts", async ({
	filePath,
	viewer,
}) => {
	const model = new MockLanguageModelV4({
		doStream: () =>
			Promise.resolve({
				stream: simulateReadableStream({
					chunkDelayInMs: 2,
					chunks: [
						{ type: "stream-start", warnings: [] },
						{ type: "text-start", id: "text-1" },
						{ type: "text-delta", id: "text-1", delta: "Checking " },
						{ type: "text-delta", id: "text-1", delta: "the weather. " },
						{ type: "text-end", id: "text-1" },
						{ type: "tool-input-start", id: "call-1", toolName: "weather" },
						{ type: "tool-input-delta", id: "call-1", delta: '{"city":' },
						{ type: "tool-input-delta", id: "call-1", delta: '"Paris"}' },
						{ type: "tool-input-end", id: "call-1" },
						{
							type: "tool-call",
							toolCallId: "call-1",
							toolName: "weather",
							input: '{"city":"Paris"}',
						},
						{ type: "text-start", id: "text-2" },
						{ type: "text-delta", id: "text-2", delta: "It is " },
						{ type: "text-delta", id: "text-2", delta: "sunny." },
						{ type: "text-end", id: "text-2" },
						{
							type: "finish",
							finishReason: { unified: "tool-calls", raw: "tool_calls" },
							usage: usage(6),
						},
					],
				}),
			}),
	})
	const chat = await ChatServer.start({ filePath, model })
	const sender = await viewer(chat, "thread-1")
	await sendMessage(sender.client, "Weather in Paris?")
	await vi.waitFor(() => expect(sender.seen.at(-1)?.status).toBe("complete"), {
		timeout: 5_000,
	})

	const [reply] = sender.client.query({
		...threadQuery("thread-1"),
		where: { threadId: "thread-1", role: "assistant" },
	})
	const parts = reply!.parts.map(fromPartRecord)
	expect(
		parts
			.filter(({ type }) => type !== "step-start")
			.map((part) => ("text" in part ? part.text : part.type)),
	).toEqual(["Checking the weather. ", "tool-weather", "It is sunny."])
	expect(parts.find(({ type }) => type === "tool-weather")).toMatchObject({
		state: "output-available",
		input: { city: "Paris" },
		output: { city: "Paris", forecast: "sunny" },
	})
	// The client shows what the server stored.
	const [stored] = await chat.tandem.query({
		...threadQuery("thread-1"),
		where: { threadId: "thread-1", role: "assistant" },
	})
	expect(reply).toEqual(stored)
	await chat.close()
})

test("the stop button aborts the reply through a client-owned run record", async ({
	filePath,
	viewer,
}) => {
	const counting = Array.from({ length: 200 }, (_, index) => `${index} `)
	const chat = await ChatServer.start({
		filePath,
		model: textModel(counting, { chunkDelayInMs: 5 }),
	})
	const sender = await viewer(chat, "thread-1")
	await sendMessage(sender.client, "Count slowly")
	await vi.waitFor(
		() => expect(sender.seen.at(-1)?.text.length).toBeGreaterThan(0),
		{ timeout: 5_000 },
	)

	const stopTx = sender.client.transact()
	stopTx.set("runs", { id: replyId("message-1"), stopRequested: true })
	await sender.client.commit(stopTx)

	await vi.waitFor(() => expect(sender.seen.at(-1)?.status).toBe("stopped"), {
		timeout: 5_000,
	})
	await chat.close()
	const stopped = sender.seen.at(-1)!
	expect(stopped.text.length).toBeLessThan(counting.join("").length)
	expect(
		sender.seen.slice(0, -1).every(({ status }) => status === "streaming"),
	).toBe(true)
})

test("a model failure ends the reply with an error status, and clients cannot write replies", async ({
	filePath,
	viewer,
}) => {
	const tokens = ["Tandem ", "delivers ", "every ", "token."]
	const chat = await ChatServer.start({
		filePath,
		model: textModel(tokens, { failAfter: 2 }),
	})
	const sender = await viewer(chat, "thread-1")
	await sendMessage(sender.client, "Fail please")
	await vi.waitFor(() => expect(sender.seen.at(-1)?.status).toBe("error"), {
		timeout: 5_000,
	})

	// Writes to the server's reply or its parts are dropped, whatever role they
	// claim, and the client shows the server's reply again once its pull
	// acknowledges them.
	const reply = replyId("message-1")
	for (const role of ["assistant", "user"] as const) {
		const forgedTx = sender.client.transact()
		forgedTx.set("messages", {
			id: reply,
			threadId: "thread-1",
			role,
			status: "complete",
			createdAt: 2,
			updatedAt: 2,
		})
		await sender.client.commit(forgedTx)
	}
	const partTx = sender.client.transact()
	partTx.set("parts", {
		...toPartRecord({ id: reply, threadId: "thread-1" }, 0, {
			type: "text",
			text: "Forged",
		}),
		messageId: "message-1",
	})
	await sender.client.commit(partTx)
	const replyQuery = {
		...threadQuery("thread-1"),
		where: { threadId: "thread-1", role: "assistant" },
	} as const
	// The model failed after its second token. A snapshot still queued when the
	// stream errors is dropped, so the stored text can end after the first.
	const [stored] = await chat.tandem.query(replyQuery)
	expect(stored && snapshotOf(stored)).toMatchObject({
		text: expect.stringMatching(/^Tandem (delivers )?$/),
		status: "error",
	})
	await vi.waitFor(
		() => expect(sender.client.query(replyQuery)).toEqual([stored]),
		{ timeout: 5_000 },
	)

	// The dropped writes do not block the client's later messages.
	await sendMessage(sender.client, "Try again", {
		id: "message-2",
		createdAt: 3,
	})
	await vi.waitFor(
		() =>
			expect(
				sender.client.query({
					collection: "messages",
					where: { id: replyId("message-2") },
				}),
			).toHaveLength(1),
		{ timeout: 5_000 },
	)
	await chat.close()
})

test("a thread reads in send order, whatever its message IDs", async ({
	filePath,
	viewer,
}) => {
	const chat = await ChatServer.start({ filePath, model: textModel(["Ok."]) })
	const sender = await viewer(chat, "thread-1")
	// The second message's ID sorts first, as random IDs often do.
	for (const [id, createdAt] of [
		["message-b", 1_000],
		["message-a", 2_000],
	] as const) {
		await sendMessage(sender.client, id, { id, createdAt })
		await vi.waitFor(
			() =>
				expect(
					sender.client.query({
						collection: "messages",
						where: { id: replyId(id) },
					})[0]?.status,
				).toBe("complete"),
			{ timeout: 5_000 },
		)
	}

	expect(
		sender.client.query(threadQuery("thread-1")).map(({ id }) => id),
	).toEqual([
		"message-b",
		replyId("message-b"),
		"message-a",
		replyId("message-a"),
	])
	await chat.close()
})

test("startup marks replies a crash left streaming as failed", async ({
	filePath,
	viewer,
}) => {
	// This model starts a reply, then never sends another token.
	const stalled = new MockLanguageModelV4({
		doStream: () =>
			Promise.resolve({
				stream: new ReadableStream({
					start: (controller) => {
						controller.enqueue({ type: "stream-start", warnings: [] })
						controller.enqueue({ type: "text-start", id: "text-1" })
						controller.enqueue({
							type: "text-delta",
							id: "text-1",
							delta: "Partial",
						})
					},
				}),
			}),
	})
	const chat = await ChatServer.start({ filePath, model: stalled })
	const sender = await viewer(chat, "thread-1")
	await sendMessage(sender.client, "Crash mid-reply")
	await vi.waitFor(
		() =>
			expect(sender.seen.at(-1)).toEqual({
				text: "Partial",
				status: "streaming",
			}),
		{ timeout: 5_000 },
	)
	await chat.crash()

	const restarted = await ChatServer.start({ filePath, model: stalled })
	const [reply] = await restarted.tandem.query({
		...threadQuery("thread-1"),
		where: { threadId: "thread-1", role: "assistant" },
	})
	expect(reply && snapshotOf(reply)).toEqual({
		text: "Partial",
		status: "error",
	})
	await restarted.close()
})
