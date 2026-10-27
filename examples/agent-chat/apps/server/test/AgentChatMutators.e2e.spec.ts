import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import {
	collection,
	defineMutators,
	defineSchema,
	Logger,
	MutationRejectedError,
	type RemoteApi,
	TandemClient,
} from "@tanishqkancharla/tandem-core"
import {
	TandemServer,
	TandemServerJsonFileStorage,
} from "@tanishqkancharla/tandem-server"
import { convertToModelMessages, type LanguageModel, streamText } from "ai"
import { MockLanguageModelV4, simulateReadableStream } from "ai/test"
import * as errore from "errore"
import { expect, test as baseTest, vi } from "vitest"
import { z } from "zod"

// docs/agent-chat.md rebuilt on custom mutations (specs/custom-mutations.md).
// Compare with AgentChat.e2e.spec.ts: no push wrapper, no write filter, no
// claim check, and no client-owned runs collection.

type Message = {
	id: string
	threadId: string
	role: "user" | "assistant"
	text: string
	status: "streaming" | "complete" | "stopped" | "error"
	updatedAt: number
}

type ChatSchema = { messages: Message }

const schema = defineSchema({
	messages: collection<Message>({
		fields: ["id", "threadId", "role", "text", "status", "updatedAt"],
	}),
})

const replyId = (messageId: string) => `${messageId}:reply`

// Shared module: the client and the server import these.
const chatMutators = defineMutators(schema, {
	/** Adds the user's message and an empty reply the server will stream into. */
	sendMessage: {
		args: z.object({
			messageId: z.string(),
			threadId: z.string(),
			text: z.string().min(1),
		}),
		run: (tx, { messageId, threadId, text }) => {
			const updatedAt = Date.now()
			tx.set("messages", {
				id: messageId,
				threadId,
				role: "user",
				text,
				status: "complete",
				updatedAt,
			})
			tx.set("messages", {
				id: replyId(messageId),
				threadId,
				role: "assistant",
				text: "",
				status: "streaming",
				updatedAt,
			})
		},
	},
	appendReply: {
		args: z.object({ id: z.string(), text: z.string() }),
		run: async (tx, { id, text }) => {
			const message = await tx.get("messages", id)
			if (message) tx.set("messages", { ...message, text: message.text + text })
		},
	},
	finishReply: {
		args: z.object({ id: z.string(), status: z.enum(["complete", "error"]) }),
		run: async (tx, { id, status }) => {
			const message = await tx.get("messages", id)
			if (message)
				tx.set("messages", { ...message, status, updatedAt: Date.now() })
		},
	},
	/** The server aborts the model; the reply's final save says "stopped". */
	stopReply: {
		args: z.object({ messageId: z.string() }),
		run: () => {},
	},
})

/** Whoever the transport authenticated. */
type Session = { threads: string[] }

class ChatServer {
	readonly tandem: TandemServer<ChatSchema, {}, typeof chatMutators, Session>
	/** Reply IDs in the order the server started them. */
	readonly started: string[] = []
	private readonly controllers = new Map<string, AbortController>()
	private readonly replies = new Set<Promise<void>>()

	constructor(
		filePath: string,
		private readonly model: LanguageModel,
		private readonly generation: "server" | "client" = "server",
	) {
		this.tandem = new TandemServer({
			schema,
			relations: {},
			storage: new TandemServerJsonFileStorage<ChatSchema>({ filePath }),
			mutators: chatMutators,
			hooks: (session: Session | undefined) => ({
				sendMessage: {
					authorize: async (tx, args, ctx) => {
						if (
							ctx.source !== "client" ||
							!session?.threads.includes(args.threadId)
						)
							throw new Error(`No access to ${args.threadId}`)
						if (
							(await tx.get("messages", args.messageId)) ||
							(await tx.get("messages", replyId(args.messageId)))
						)
							throw new Error(`Message ${args.messageId} exists`)
					},
					...(this.generation === "server" && {
						afterCommit: (args) =>
							this.startReply(replyId(args.messageId), args.threadId),
					}),
				},
				appendReply: {
					authorize: async (tx, args, ctx) => {
						const reply = await tx.get("messages", args.id)
						if (
							!reply ||
							!args.id.endsWith(":reply") ||
							reply.status !== "streaming"
						)
							throw new Error("No streaming reply")
						if (
							this.generation === "server"
								? ctx.source !== "server"
								: ctx.source !== "client" ||
									!session?.threads.includes(reply.threadId)
						)
							throw new Error("No access to reply")
					},
				},
				finishReply: {
					authorize: async (tx, { id }, ctx) => {
						const reply = await tx.get("messages", id)
						if (
							this.generation !== "client" ||
							ctx.source !== "client" ||
							!reply ||
							!id.endsWith(":reply") ||
							reply.status !== "streaming" ||
							!session?.threads.includes(reply.threadId)
						)
							throw new Error("No access to reply")
					},
				},
				stopReply: {
					authorize: async (tx, { messageId }, ctx) => {
						const reply = await tx.get("messages", replyId(messageId))
						if (
							ctx.source !== "client" ||
							!reply ||
							!session?.threads.includes(reply.threadId)
						)
							throw new Error(`No reply to ${messageId}`)
					},
					afterCommit: ({ messageId }) =>
						this.controllers.get(replyId(messageId))?.abort(),
				},
			}),
		})
	}

	/** The JSON transport a browser would use. */
	remote(
		session: Session,
		network: { loseNextPushResponse?: boolean } = {},
	): RemoteApi<ChatSchema> {
		const overJson = <Value>(value: Value): Value =>
			JSON.parse(JSON.stringify(value)) as Value
		return {
			connect: (client) =>
				this.tandem.connect({
					...client,
					poke: (payload) => client.poke(payload && overJson(payload)),
				}),
			push: async (args) => {
				// With mutators, the push refuses raw set/update/remove operations.
				const response = await this.tandem.push(overJson(args), {
					context: session,
				})
				if (!network.loseNextPushResponse) return overJson(response)
				network.loseNextPushResponse = false
				return { error: "unavailable", message: "Response lost" }
			},
			pull: async (args) => overJson(await this.tandem.pull(overJson(args))),
		}
	}

	async close() {
		await Promise.all(this.replies)
		await this.tandem.close()
	}

	private startReply(id: string, threadId: string) {
		this.started.push(id)
		const reply = this.streamReply(id, threadId).then((result) => {
			if (result instanceof Error) console.error(result)
		})
		this.replies.add(reply)
		void reply.then(() => this.replies.delete(reply))
	}

	private async streamReply(id: string, threadId: string) {
		// Registered before any await, so a later stopReply always finds it.
		await using cleanup = new errore.AsyncDisposableStack()
		const controller = new AbortController()
		this.controllers.set(id, controller)
		cleanup.defer(() => {
			this.controllers.delete(id)
		})
		const thread = await this.tandem.query({
			collection: "messages",
			where: { threadId },
		})
		const result = streamText({
			model: this.model,
			messages: await convertToModelMessages(
				thread
					.filter((message) => message.id !== id)
					.map((message) => ({
						id: message.id,
						role: message.role,
						parts: [{ type: "text" as const, text: message.text }],
					})),
			),
			abortSignal: controller.signal,
		})
		const streamed = await (async () => {
			for await (const delta of result.textStream)
				await this.tandem.mutate.appendReply({ id, text: delta })
		})().catch((cause) => new Error(`Reply ${id} failed`, { cause }))
		const tx = this.tandem.transact()
		await tx.update("messages", id, {
			status:
				streamed instanceof Error
					? "error"
					: controller.signal.aborted
						? "stopped"
						: "complete",
			updatedAt: Date.now(),
		})
		await this.tandem.commit(tx)
		if (streamed instanceof Error) return streamed
	}
}

function textModel(tokens: string[], chunkDelayInMs = 2) {
	return new MockLanguageModelV4({
		doStream: () =>
			Promise.resolve({
				stream: simulateReadableStream({
					chunkDelayInMs,
					chunks: [
						{ type: "stream-start", warnings: [] },
						{ type: "text-start", id: "text-1" },
						...tokens.map((delta) => ({
							type: "text-delta" as const,
							id: "text-1",
							delta,
						})),
						{ type: "text-end", id: "text-1" },
						{
							type: "finish",
							finishReason: { unified: "stop", raw: "stop" },
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
					],
				}),
			}),
	})
}

const textOf = (message: Message | undefined) => message?.text

const test = baseTest.extend<{
	filePath: string
	/** A connected viewer of thread-1 for a session. */
	viewer: (
		chat: ChatServer,
		session: Session,
		network?: { loseNextPushResponse?: boolean },
	) => Promise<TandemClient<ChatSchema, {}, typeof chatMutators>>
}>({
	filePath: async ({}, use) => {
		const directory = await fs.mkdtemp(
			path.join(os.tmpdir(), "tandem-agent-chat-mutators-"),
		)
		await use(path.join(directory, "tandem.json"))
		await fs.rm(directory, { recursive: true, force: true })
	},
	viewer: async ({}, use) => {
		await using cleanup = new errore.AsyncDisposableStack()
		await use(async (chat, session, network) => {
			const client = new TandemClient({
				schema,
				mutators: chatMutators,
				remote: chat.remote(session, network),
				logger: new Logger({ sinks: [] }),
				syncInterval: 0,
			})
			const thread = client.subscribe({
				collection: "messages",
				where: { threadId: "thread-1" },
			})
			cleanup.defer(async () => {
				thread.destroy()
				await client.disconnect()
			})
			await client.ready
			await client.pullFromRemote()
			return client
		})
	},
})

const tokens = ["Mutators ", "run ", "on ", "both ", "sides."]
const member: Session = { threads: ["thread-1"] }

const reply = (
	client: TandemClient<ChatSchema, {}, typeof chatMutators>,
	messageId: string,
) =>
	client.query({ collection: "messages", where: { id: replyId(messageId) } })[0]

test("sending shows the message and an empty reply at once, then the server streams the reply", async ({
	filePath,
	viewer,
}) => {
	const chat = new ChatServer(filePath, textModel(tokens))
	const client = await viewer(chat, member)

	const shown: { text: string | undefined; status: Message["status"] }[] = []
	client.subscribe(
		{ collection: "messages", where: { id: replyId("message-1") } },
		([message]) => {
			const snapshot = message && {
				text: textOf(message),
				status: message.status,
			}
			if (snapshot && JSON.stringify(snapshot) !== JSON.stringify(shown.at(-1)))
				shown.push(snapshot)
		},
	)

	await client.mutate.sendMessage({
		messageId: "message-1",
		threadId: "thread-1",
		text: "How do mutators work?",
	})

	await vi.waitFor(
		() => expect(reply(client, "message-1")?.status).toBe("complete"),
		{ timeout: 5_000 },
	)
	// The optimistic run showed the empty reply before the server saved any text.
	expect(shown[0]).toEqual({ text: "", status: "streaming" })
	expect(shown.at(-1)).toEqual({ text: tokens.join(""), status: "complete" })
	await chat.close()
})

test("a client consumes model chunks and syncs a complete reply to another viewer", async ({
	filePath,
	viewer,
}) => {
	const chat = new ChatServer(filePath, textModel(tokens), "client")
	const writer = await viewer(chat, member)
	const reader = await viewer(chat, member)
	const outsider = await viewer(chat, { threads: [] })
	await writer.mutate.sendMessage({
		messageId: "message-1",
		threadId: "thread-1",
		text: "Stream here",
	})
	await expect(
		outsider.mutate.appendReply({
			id: replyId("message-1"),
			text: "forged",
		}),
	).rejects.toThrow("No access to reply")
	const stream = streamText({ model: textModel(tokens), prompt: "Stream here" })
	for await (const delta of stream.textStream)
		await writer.mutate.appendReply({ id: replyId("message-1"), text: delta })
	await writer.mutate.finishReply({
		id: replyId("message-1"),
		status: "complete",
	})
	await vi.waitFor(() =>
		expect(reply(reader, "message-1")).toMatchObject({
			text: tokens.join(""),
			status: "complete",
		}),
	)
	expect(chat.started).toEqual([])
	await chat.close()
})

test("a retried push starts each reply once", async ({ filePath, viewer }) => {
	const chat = new ChatServer(filePath, textModel(tokens))
	const network = { loseNextPushResponse: true }
	const client = await viewer(chat, member, network)

	// The server applies the first message, but its response is lost.
	await expect(
		client.mutate.sendMessage({
			messageId: "message-1",
			threadId: "thread-1",
			text: "First",
		}),
	).rejects.toThrow("Remote push failed")
	// The next push resends it with the second message.
	await client.mutate.sendMessage({
		messageId: "message-2",
		threadId: "thread-1",
		text: "Second",
	})

	await vi.waitFor(
		() => {
			expect(reply(client, "message-1")?.status).toBe("complete")
			expect(reply(client, "message-2")?.status).toBe("complete")
		},
		{ timeout: 5_000 },
	)
	expect(chat.started).toEqual(["message-1:reply", "message-2:reply"])
	await chat.close()
})

test("the server refuses forged and unauthorized writes without blocking later messages", async ({
	filePath,
	viewer,
}) => {
	const chat = new ChatServer(filePath, textModel(tokens))
	const client = await viewer(chat, member)

	// A message to a thread the session cannot write.
	await expect(
		client.mutate.sendMessage({
			messageId: "message-1",
			threadId: "thread-2",
			text: "Not mine",
		}),
	).rejects.toThrow("No access to thread-2")
	// A raw write of a reply, which only mutators may make.
	const forgedTx = client.transact()
	forgedTx.set("messages", {
		id: replyId("message-0"),
		threadId: "thread-1",
		role: "assistant",
		text: "Forged",
		status: "complete",
		updatedAt: 0,
	})
	await expect(client.commit(forgedTx)).rejects.toBeInstanceOf(
		MutationRejectedError,
	)
	await vi.waitFor(() =>
		expect(client.query({ collection: "messages" })).toEqual([]),
	)

	await client.mutate.sendMessage({
		messageId: "message-2",
		threadId: "thread-1",
		text: "Allowed",
	})
	await vi.waitFor(
		() => expect(reply(client, "message-2")?.status).toBe("complete"),
		{ timeout: 5_000 },
	)
	expect(chat.started).toEqual(["message-2:reply"])
	await chat.close()
})

test("stopReply aborts the model and the reply keeps the text so far", async ({
	filePath,
	viewer,
}) => {
	const counting = Array.from({ length: 200 }, (_, index) => `${index} `)
	const chat = new ChatServer(filePath, textModel(counting, 5))
	const client = await viewer(chat, member)
	await client.mutate.sendMessage({
		messageId: "message-1",
		threadId: "thread-1",
		text: "Count slowly",
	})
	await vi.waitFor(
		() => expect(textOf(reply(client, "message-1"))?.length).toBeGreaterThan(0),
		{ timeout: 5_000 },
	)

	await client.mutate.stopReply({ messageId: "message-1" })

	await vi.waitFor(
		() => expect(reply(client, "message-1")?.status).toBe("stopped"),
		{ timeout: 5_000 },
	)
	expect(textOf(reply(client, "message-1"))!.length).toBeLessThan(
		counting.join("").length,
	)
	await chat.close()
})
