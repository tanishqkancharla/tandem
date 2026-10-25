# Agent chat

This guide builds a streaming agent chat on Tandem. There is no separate stream and no version field. The server saves the reply record as it generates, and every client subscribed to the thread sees the text grow through an ordinary `useTandemQuery` or `client.subscribe`.

This works because [`TandemServer`](server.md#connect-clients) sends each commit's changed records to the clients that can see them, and clients show them at once ([live records](sync.md#live-records)). Each save reaches every viewer in one hop, in order, and never moves backwards.

## Rules

1. One writer per record. Clients write user messages. Only the server writes assistant messages, under reply IDs the push handler keeps clients from writing.
2. The server saves the reply about every 100 ms while it generates, with `status: "streaming"`. When the model loop ends it saves a final status: `"complete"` on a normal end, `"stopped"` on abort, `"error"` on a throw.
3. Anything the client says about a reply goes in a record the client owns. The stop button sets `stopRequested` on a `runs` record, and the server aborts the model.
4. A crash can leave a reply `"streaming"` forever. The server marks those as `"error"` on startup, and clients treat a reply whose `updatedAt` stopped advancing as failed.

## Data model

Store each message as its own record. With the [Vercel AI SDK](https://ai-sdk.dev), keep the `UIMessage` parts on the record.

```ts
import { collection, defineSchema } from "@tanishqkancharla/tandem-core"
import type { UIMessage } from "ai"

type Message = {
	id: string
	threadId: string
	role: "user" | "assistant"
	parts: UIMessage["parts"]
	status: "streaming" | "complete" | "stopped" | "error"
	/** Orders the thread. A reply sorts right after its user message. */
	createdAt: number
	/** When the server last saved the message. */
	updatedAt: number
}

/** Written by the client to control one reply. */
type Run = { id: string; stopRequested: boolean }

type ChatSchema = { messages: Message; runs: Run }

const schema = defineSchema({
	messages: collection<Message>({
		fields: ["id", "threadId", "role", "parts", "status", "createdAt", "updatedAt"],
	}),
	runs: collection<Run>({ fields: ["id", "stopRequested"] }),
})
```

`fields` lists the record's fields without per-field codecs, so `parts` holds any JSON value.

## Server

The server is an ordinary [`TandemServer`](server.md). `model` is any AI SDK language model; tests can use `MockLanguageModelV4` from `ai/test`.

```ts
import type { MutationOp } from "@tanishqkancharla/tandem-core"
import { TandemServer, TandemServerJsonFileStorage } from "@tanishqkancharla/tandem-server"

const server = new TandemServer({
	schema,
	relations: {},
	storage: new TandemServerJsonFileStorage<ChatSchema>({ filePath: "./data/chat.json" }),
})
```

Wrap it in the transport the client calls ([Custom remotes](custom-remote.md#wrapping-tandemserver)). Drop operations a client may not make instead of returning an error: the mutation is still acknowledged, and the client's next pull shows the server's record again. An error would leave the mutation pending, and every later push from that client would fail with it. The commit still resolves and the dropped write shows locally until that pull, so validate in the UI too.

Reply IDs are reserved for the server, so the check needs no lookup: a client cannot overwrite a reply by calling it a user message. This only protects replies; who may write which thread is up to your authorization.

```ts
const replyId = (messageId: string) => `${messageId}:reply`
const isReplyId = (id: string) => id.endsWith(":reply")

function isClientWrite(op: MutationOp<ChatSchema>) {
	if (op.collection === "runs") return op.type !== "remove"
	return op.type === "set" && op.value.role === "user" && !isReplyId(op.value.id)
}

const replies = new Set<Promise<void>>()

async push(args) {
	const mutations = args.mutations.map((mutation) => ({
		...mutation,
		ops: mutation.ops.filter(isClientWrite),
	}))
	const response = await server.push({ ...args, mutations })
	if ("error" in response) return response
	for (const { ops } of mutations) {
		for (const op of ops) {
			if (op.type !== "set" || op.collection !== "messages") continue
			// Await these on shutdown.
			const reply = streamReply(op.value)
			replies.add(reply)
			void reply.finally(() => replies.delete(reply))
		}
	}
	return response
}
```

The reply loop uses the AI SDK on the server only: `streamText`, then `toUIMessageStream`, then `readUIMessageStream`. Each snapshot replaces `parts`; a timer saves the newest one. Do not use `useChat` on the client; the client reads the record.

```ts
import { convertToModelMessages, readUIMessageStream, streamText, toUIMessageStream } from "ai"

async function streamReply(userMessage: Message) {
	const id = replyId(userMessage.id)
	const claimTx = server.transact()
	// A retried push must not start a second reply.
	if (await claimTx.get("messages", id)) return claimTx.cancel()
	const reply: Message = {
		id,
		threadId: userMessage.threadId,
		role: "assistant",
		parts: [],
		status: "streaming",
		// Follow the user message even if the sender's clock is off.
		createdAt: userMessage.createdAt + 1,
		updatedAt: Date.now(),
	}
	claimTx.set("messages", reply)
	await server.commit(claimTx)

	// The stop button sets stopRequested on this reply's run.
	const controller = new AbortController()
	const runs = await server.subscribe({ collection: "runs", where: { id } }, ([run]) => {
		if (run?.stopRequested) controller.abort()
	})
	if (runs.result[0]?.stopRequested) controller.abort()

	const thread = await server.query({
		collection: "messages",
		where: { threadId: userMessage.threadId },
		orderBy: { createdAt: "asc" },
	})
	const result = streamText({
		model,
		messages: await convertToModelMessages(thread.filter((message) => message.id !== id)),
		abortSignal: controller.signal,
	})

	let parts: Message["parts"] = []
	let savedParts = parts
	let savedAt = Date.now()
	let saving = Promise.resolve()
	const save = (status: Message["status"]) => {
		const message = { ...reply, parts, status, updatedAt: Date.now() }
		savedParts = parts
		savedAt = message.updatedAt
		saving = saving.then(async () => {
			const tx = server.transact()
			tx.set("messages", message)
			await server.commit(tx)
		})
		return saving
	}
	// Save new text every 100 ms, and at least every 5 seconds as a heartbeat.
	const timer = setInterval(() => {
		if (parts !== savedParts || Date.now() - savedAt >= 5_000)
			save("streaming").catch(console.error)
	}, 100)

	const streamed = await (async () => {
		const messages = readUIMessageStream({
			stream: toUIMessageStream({ stream: result.stream }),
			terminateOnError: true,
		})
		for await (const message of messages) parts = message.parts
	})().catch((cause) => new Error(`Reply ${id} failed`, { cause }))

	clearInterval(timer)
	runs.destroy()
	if (streamed instanceof Error) await save("error")
	else await save(controller.signal.aborted ? "stopped" : "complete")
}
```

An abort ends the loop without throwing, so the signal decides between `"complete"` and `"stopped"`. A model error throws because of `terminateOnError`.

Before serving requests, mark replies a crash left behind:

```ts
const interrupted = await server.query({
	collection: "messages",
	where: { status: "streaming" },
})
const tx = server.transact()
for (const message of interrupted) {
	tx.set("messages", { ...message, status: "error", updatedAt: Date.now() })
}
await server.commit(tx)
```

Run one `TandemServer` process for the chat. Live records come from the process that committed, so a client whose pokes and pulls reach different processes falls back to a poke and a pull per save.

## Client

Send a message with an ordinary commit:

```ts
const tx = client.transact()
tx.set("messages", {
	id: messageId,
	threadId,
	role: "user",
	parts: [{ type: "text", text }],
	status: "complete",
	createdAt: Date.now(),
	updatedAt: Date.now(),
})
await client.commit(tx)
```

Read the thread with a plain query ordered by `createdAt`, and branch on `status`. Without `orderBy`, the order is unspecified. A `"streaming"` reply that the server has not saved for a while belongs to a crashed process:

```tsx
const messages = useTandemQuery({
	collection: "messages",
	where: { threadId },
	orderBy: { createdAt: "asc" },
})

const stale = (message: Message) =>
	message.status === "streaming" && Date.now() - message.updatedAt > 15_000

return messages?.map((message) =>
	message.status === "error" || stale(message) ? (
		<Failed key={message.id} message={message} />
	) : (
		<Bubble key={message.id} message={message} streaming={message.status === "streaming"} />
	),
)
```

Re-check staleness on a timer if no other render would happen. A stopped reply keeps the text generated so far.

The stop button writes the run record the server watches:

```ts
const tx = client.transact()
tx.set("runs", { id: replyId(messageId), stopRequested: true })
await client.commit(tx)
```

## Notes

- Subscribe to the open thread only. Every save still starts a pull for each viewer, and a pull returns the whole scan window.
- Saves replace `parts` with the full snapshot so far. For very long replies, split a turn into several message records so each save stays small.
- Every viewer of the thread sees the reply grow, not only the sender.

The end-to-end test in [`examples/agent-chat/apps/server/test/AgentChat.e2e.spec.ts`](../examples/agent-chat/apps/server/test/AgentChat.e2e.spec.ts) implements this guide with the AI SDK's mock model: two viewers with slow pulls, the stop button, a model error, and startup cleanup.
