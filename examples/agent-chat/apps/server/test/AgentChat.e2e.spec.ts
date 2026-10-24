import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import {
	collection,
	defineSchema,
	Logger,
	type Mutation,
	type RemoteApi,
	TandemClient,
} from "@tanishqkancharla/tandem-core"
import {
	TandemServer,
	TandemServerJsonFileStorage,
} from "@tanishqkancharla/tandem-server"
import {
	convertToModelMessages,
	type LanguageModel,
	readUIMessageStream,
	streamText,
	toUIMessageStream,
	type UIMessage,
} from "ai"
import { MockLanguageModelV4, simulateReadableStream } from "ai/test"
import * as errore from "errore"
import { expect, test as baseTest, vi } from "vitest"

// The reference implementation of docs/agent-chat.md.

type Message = {
	id: string
	threadId: string
	role: "user" | "assistant"
	parts: UIMessage["parts"]
	status: "streaming" | "complete" | "stopped" | "error"
	/** When the server last saved the message. A stale "streaming" reply failed. */
	updatedAt: number
}

/** Client-owned controls for one reply. */
type Run = { id: string; stopRequested: boolean }

type ChatSchema = { messages: Message; runs: Run }

const schema = defineSchema({
	messages: collection<Message>({
		fields: ["id", "threadId", "role", "parts", "status", "updatedAt"],
	}),
	runs: collection<Run>({ fields: ["id", "stopRequested"] }),
})

type ChatTandem = TandemServer<ChatSchema, {}>

class ReplyError extends errore.createTaggedError({
	name: "ReplyError",
	message: "Reply $id failed",
}) {}

const replyId = (userMessageId: string) => `${userMessageId}:reply`

/** Clients write user messages and runs. Only the server writes assistant messages. */
function isClientWrite(mutation: Mutation<ChatSchema>) {
	return mutation.ops.every((op) =>
		op.collection === "runs"
			? op.type !== "remove"
			: op.type === "set" && op.value.role === "user",
	)
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
	/** Server-side record of every saved reply snapshot, for the test to compare. */
	readonly saved: Snapshot[] = []
	private readonly stopTimers = new Set<() => void>()
	private readonly replies = new Set<Promise<void>>()

	private constructor(
		readonly tandem: ChatTandem,
		private readonly model: LanguageModel,
		private readonly saveInterval: number,
	) {}

	static async start({
		filePath,
		model,
		saveInterval = 100,
	}: {
		filePath: string
		model: LanguageModel
		saveInterval?: number
	}) {
		const tandem = new TandemServer({
			schema,
			relations: {},
			storage: new TandemServerJsonFileStorage<ChatSchema>({ filePath }),
		})
		await failInterruptedReplies(tandem)
		return new ChatServer(tandem, model, saveInterval)
	}

	/** The JSON transport a browser would use, with slow pull responses. */
	remote({ pullLatency }: { pullLatency: number }): RemoteApi<ChatSchema> {
		const overJson = <Value>(value: Value): Value =>
			JSON.parse(JSON.stringify(value)) as Value
		return {
			connect: (client) =>
				this.tandem.connect({
					...client,
					poke: (payload) => client.poke(payload && overJson(payload)),
				}),
			push: async (args) => {
				if (!args.mutations.every(isClientWrite)) {
					return {
						error: "invalid-request",
						message: "Only the server writes assistant messages",
					}
				}
				const response = await this.tandem.push(overJson(args))
				if ("error" in response) return response
				for (const { ops } of args.mutations) {
					for (const op of ops) {
						if (op.type === "set" && op.collection === "messages")
							this.startReply(op.value)
					}
				}
				return response
			},
			pull: async (args) => {
				const response = await this.tandem.pull(overJson(args))
				await new Promise((resolve) => setTimeout(resolve, pullLatency))
				return overJson(response)
			},
		}
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
			parts: [],
			status: "streaming",
			updatedAt: Date.now(),
		}
		claimTx.set("messages", reply)
		await this.tandem.commit(claimTx)
		this.record(reply)

		// The stop button writes the client-owned run record.
		const controller = new AbortController()
		const stop = await this.tandem.subscribe(
			{ collection: "runs", where: { id } },
			([run]) => {
				if (run?.stopRequested) controller.abort()
			},
		)
		if (stop.result[0]?.stopRequested) controller.abort()

		const thread = await this.tandem.query({
			collection: "messages",
			where: { threadId: userMessage.threadId },
		})
		const result = streamText({
			model: this.model,
			messages: await convertToModelMessages(
				thread.filter((message) => message.id !== id),
			),
			abortSignal: controller.signal,
		})

		let parts: Message["parts"] = []
		let savedParts = parts
		let savedAt = Date.now()
		let saving: Promise<void> = Promise.resolve()
		const save = (status: Message["status"]) => {
			const message = { ...reply, parts, status, updatedAt: Date.now() }
			savedParts = parts
			savedAt = message.updatedAt
			saving = saving.then(async () => {
				const tx = this.tandem.transact()
				tx.set("messages", message)
				await this.tandem.commit(tx)
				this.record(message)
			})
			return saving
		}
		// Save new text each interval, and at least every 5 seconds as a heartbeat.
		const timer = setInterval(() => {
			if (parts !== savedParts || Date.now() - savedAt >= 5_000)
				void save("streaming")
		}, this.saveInterval)
		const stopTimer = () => clearInterval(timer)
		this.stopTimers.add(stopTimer)

		const streamed = await (async () => {
			const messages = readUIMessageStream({
				stream: toUIMessageStream({ stream: result.stream }),
				terminateOnError: true,
			})
			for await (const message of messages) parts = message.parts
		})().catch((cause) => new ReplyError({ id, cause }))

		stopTimer()
		this.stopTimers.delete(stopTimer)
		stop.destroy()
		if (streamed instanceof Error) {
			await save("error")
			return streamed
		}
		await save(controller.signal.aborted ? "stopped" : "complete")
	}

	private record(message: Message) {
		const snapshot = snapshotOf(message)
		if (JSON.stringify(snapshot) !== JSON.stringify(this.saved.at(-1)))
			this.saved.push(snapshot)
	}
}

type Snapshot = { text: string; status: Message["status"] }

function snapshotOf(message: Message): Snapshot {
	const text = message.parts
		.map((part) => (part.type === "text" ? part.text : ""))
		.join("")
	return { text, status: message.status }
}

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
										usage: {
											inputTokens: {
												total: 1,
												noCache: 1,
												cacheRead: 0,
												cacheWrite: 0,
											},
											outputTokens: {
												total: tokens.length,
												text: tokens.length,
												reasoning: 0,
											},
										},
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
	) => Promise<{ client: TandemClient<ChatSchema, {}>; seen: Snapshot[] }>
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
			const client = new TandemClient<ChatSchema, {}>({
				schema,
				remote: chat.remote({ pullLatency: 15 }),
				logger: new Logger({ sinks: [] }),
				syncInterval: 0,
			})
			const seen: Snapshot[] = []
			const thread = client.subscribe(
				{ collection: "messages", where: { threadId } },
				(messages) => {
					const reply = messages.find(({ role }) => role === "assistant")
					if (!reply) return
					const snapshot = snapshotOf(reply)
					if (JSON.stringify(snapshot) !== JSON.stringify(seen.at(-1)))
						seen.push(snapshot)
				},
			)
			cleanup.defer(async () => {
				thread.destroy()
				await client.disconnect()
			})
			await client.ready
			await client.pullFromRemote()
			return { client, seen }
		})
	},
})

const userMessage = (text: string): Message => ({
	id: "message-1",
	threadId: "thread-1",
	role: "user",
	parts: [{ type: "text", text }],
	status: "complete",
	updatedAt: 0,
})

const tokens = [
	"Tandem ",
	"delivers ",
	"every ",
	"save ",
	"to ",
	"every ",
	"viewer.",
]

test("every viewer shows every saved snapshot of a streamed reply, in order", async ({
	filePath,
	viewer,
}) => {
	const chat = await ChatServer.start({
		filePath,
		model: textModel(tokens, { chunkDelayInMs: 4 }),
		saveInterval: 10,
	})
	const sender = await viewer(chat, "thread-1")
	const friend = await viewer(chat, "thread-1")

	const tx = sender.client.transact()
	tx.set("messages", userMessage("Does streaming need a stream?"))
	await sender.client.commit(tx)

	const final = { text: tokens.join(""), status: "complete" }
	await vi.waitFor(() => expect(chat.saved.at(-1)).toEqual(final), {
		timeout: 5_000,
	})
	await chat.close()

	// Pulls lag behind saves, yet neither viewer skips a save or moves back.
	expect(chat.saved.length).toBeGreaterThan(3)
	expect(sender.seen).toEqual(chat.saved)
	expect(friend.seen).toEqual(chat.saved)
})

test("the stop button aborts the reply through a client-owned run record", async ({
	filePath,
	viewer,
}) => {
	const chat = await ChatServer.start({
		filePath,
		model: textModel(
			Array.from({ length: 200 }, (_, index) => `${index} `),
			{
				chunkDelayInMs: 5,
			},
		),
		saveInterval: 10,
	})
	const sender = await viewer(chat, "thread-1")
	const tx = sender.client.transact()
	tx.set("messages", userMessage("Count slowly"))
	await sender.client.commit(tx)
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
	expect(stopped.text.length).toBeLessThan(
		Array.from({ length: 200 }, (_, index) => `${index} `).join("").length,
	)
	expect(
		sender.seen.slice(0, -1).every(({ status }) => status === "streaming"),
	).toBe(true)
})

test("a model failure ends the reply with an error status, and clients cannot write replies", async ({
	filePath,
	viewer,
}) => {
	const chat = await ChatServer.start({
		filePath,
		model: textModel(tokens, { failAfter: 2 }),
		saveInterval: 10,
	})
	const sender = await viewer(chat, "thread-1")
	const tx = sender.client.transact()
	tx.set("messages", userMessage("Fail please"))
	await sender.client.commit(tx)
	await vi.waitFor(() => expect(sender.seen.at(-1)?.status).toBe("error"), {
		timeout: 5_000,
	})

	// The push handler rejects a client's write to the server's reply.
	const forgedTx = sender.client.transact()
	forgedTx.set("messages", {
		...userMessage("Forged"),
		id: replyId("message-1"),
		role: "assistant",
	})
	await expect(sender.client.commit(forgedTx)).rejects.toThrow()
	await chat.close()
	expect(
		(
			await chat.tandem.query({
				collection: "messages",
				where: { role: "assistant" },
			})
		)
			.map(snapshotOf)
			.at(-1)?.status,
	).toBe("error")
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
	const chat = await ChatServer.start({
		filePath,
		model: stalled,
		saveInterval: 10,
	})
	const sender = await viewer(chat, "thread-1")
	const tx = sender.client.transact()
	tx.set("messages", userMessage("Crash mid-reply"))
	await sender.client.commit(tx)
	await vi.waitFor(
		() =>
			expect(chat.saved.at(-1)).toEqual({
				text: "Partial",
				status: "streaming",
			}),
		{ timeout: 5_000 },
	)
	await chat.crash()

	const restarted = await ChatServer.start({ filePath, model: stalled })
	const [reply] = await restarted.tandem.query({
		collection: "messages",
		where: { role: "assistant" },
	})
	expect(reply && snapshotOf(reply)).toEqual({
		text: "Partial",
		status: "error",
	})
	await restarted.close()
})
