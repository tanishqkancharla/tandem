# Agent chat

This guide builds a streaming agent chat on Tandem. There is no separate stream and no version field. The server appends each text delta to the reply as the model generates it, and every client subscribed to the thread sees the text grow through an ordinary `useTandemQuery` or `client.subscribe`.

This works because [`TandemServer`](server.md#connect-clients) sends each commit's changes to the clients that can see them, and clients show them at once ([live records](sync.md#live-records)). An [`append`](server.md#append-text) sends only the new text. The server merges a burst of commits into one payload per client every 50 ms (`livePokeInterval` on the server), and a client confirms what it was shown with one pull once payloads stop for 200 ms, and at least once a second while they keep coming ([`livePullDelay` and `livePullMaxDelay`](sync.md#poke) on the client). So the reply loop can commit every delta with no timer of its own.

## Rules

1. One writer per record. Clients write user messages. Only the server writes assistant messages and their parts, under reply IDs the push handler keeps clients from writing.
2. The server appends each text delta to the reply's text part and replaces a tool part whenever it changes. When the model loop ends it saves a final status: `"complete"` on a normal end, `"stopped"` on abort, `"error"` on a throw.
3. Anything the client says about a reply goes in a record the client owns. The stop button sets `stopRequested` on a `runs` record, and the server aborts the model.
4. A crash can leave a reply `"streaming"` forever. The server marks those as `"error"` on startup, and clients treat a reply whose `updatedAt` stopped advancing as failed. A heartbeat keeps `updatedAt` fresh while the model runs, including during long tool calls.

## Data model

Store each message as a record, and each of its parts as a record of its own. With the [Vercel AI SDK](https://ai-sdk.dev), a part record holds one `UIMessage` part. Text and reasoning parts keep their text in a top-level `text` field, because `append` extends top-level string fields.

```ts
import { collection, defineRelations, defineSchema } from "@tanishqkancharla/tandem-core"
import type { UIMessage } from "ai"

type Message = {
	id: string
	threadId: string
	role: "user" | "assistant"
	status: "streaming" | "complete" | "stopped" | "error"
	/** Orders the thread. A reply sorts right after its user message. */
	createdAt: number
	/** When the server last saved the message. */
	updatedAt: number
}

type UIPart = UIMessage["parts"][number]

type Part = {
	id: string
	threadId: string
	messageId: string
	/** The part's position in the message. */
	index: number
	/** A text or reasoning part's text. The server appends to it. */
	text: string
	/** The rest of the part, with `text` left empty. */
	part: UIPart
}

/** Written by the client to control one reply. */
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

const partId = (messageId: string, index: number) => `${messageId}:${index}`

function toPartRecord(message: Pick<Message, "id" | "threadId">, index: number, part: UIPart): Part {
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
```

`fields` lists the record's fields without per-field codecs, so `part` holds any JSON value. Keeping each part in its own record keeps every write small: a delta sends a few characters, and a tool update sends only that tool's part.

## Server

The server is an ordinary [`TandemServer`](server.md) with the relations. `model` is any AI SDK language model; tests can use `MockLanguageModelV4` from `ai/test`.

```ts
import type { MutationOp, RemoteApi } from "@tanishqkancharla/tandem-core"
import {
	TandemServer,
	TandemServerJsonFileStorage,
	type TandemServerTransaction,
} from "@tanishqkancharla/tandem-server"

const server = new TandemServer({
	schema,
	relations,
	storage: new TandemServerJsonFileStorage<ChatSchema>({ filePath: "./data/chat.json" }),
})
```

Wrap it in the transport the client calls ([Custom remotes](custom-remote.md#wrapping-tandemserver)). Drop operations a client may not make instead of returning an error: the mutation is still acknowledged, and the client's next pull shows the server's record again. An error would leave the mutation pending, and every later push from that client would fail with it. The commit still resolves and the dropped write shows locally until that pull, so validate in the UI too.

Reply IDs are reserved for the server, so the check needs no lookup: a client cannot overwrite a reply, or one of its parts, by calling it a user message. This only protects replies; who may write which thread is up to your authorization.

```ts
const replyId = (messageId: string) => `${messageId}:reply`
const isReplyId = (id: string) => id.endsWith(":reply")

function isClientWrite(op: MutationOp<ChatSchema>) {
	if (op.collection === "runs") return op.type !== "remove"
	if (op.type !== "set") return false
	if (op.collection === "messages") return op.value.role === "user" && !isReplyId(op.value.id)
	return !isReplyId(op.value.messageId) && op.value.id === partId(op.value.messageId, op.value.index)
}

const replies = new Set<Promise<void>>()

// What your HTTP or WebSocket handlers call for this client.
const remote: RemoteApi<ChatSchema> = {
	connect: (client) => server.connect(client),
	pull: (args) => server.pull(args),
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
				const reply = streamReply(op.value)
				replies.add(reply)
				void reply.finally(() => replies.delete(reply))
			}
		}
		return response
	},
}

async function shutdown() {
	await Promise.all(replies)
	await server.close()
}
```

The reply loop uses the AI SDK on the server only: `streamText`, then `toUIMessageStream`, then `readUIMessageStream`. Each snapshot of the message is compared with the one before it. Text that grew is appended; any other change sets that part whole. Commit every snapshot; Tandem batches them for clients. Do not use `useChat` on the client; the client reads the records.

```ts
import { convertToModelMessages, readUIMessageStream, streamText, toUIMessageStream } from "ai"

/** Writes what changed between two snapshots of a reply's parts. */
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
		if (!grew) return tx.set("parts", next)
		const delta = next.text.slice(saved.text.length)
		if (delta) tx.append("parts", next.id, { text: delta })
	})
}

async function streamReply(userMessage: Message) {
	const id = replyId(userMessage.id)
	const claimTx = server.transact()
	// A retried push must not start a second reply.
	if (await claimTx.get("messages", id)) return claimTx.cancel()
	const reply: Message = {
		id,
		threadId: userMessage.threadId,
		role: "assistant",
		status: "streaming",
		// Follow the user message even if the sender's clock is off.
		createdAt: userMessage.createdAt + 1,
		updatedAt: Date.now(),
	}
	claimTx.set("messages", reply)
	await server.commit(claimTx)

	// The server is the reply record's only writer, so each save sets it whole.
	const saveStatus = (status: Message["status"]) => {
		const tx = server.transact()
		tx.set("messages", { ...reply, status, updatedAt: Date.now() })
		return server.commit(tx)
	}
	// Clients treat a reply that stops saving for 15 seconds as failed.
	const heartbeat = setInterval(() => void saveStatus("streaming").catch(console.error), 5_000)

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
		with: { parts: { orderBy: { index: "asc" } } },
	})
	const result = streamText({
		model,
		messages: await convertToModelMessages(
			thread
				.filter((message) => message.id !== id)
				.map(({ id, role, parts }) => ({ id, role, parts: parts.map(fromPartRecord) })),
		),
		abortSignal: controller.signal,
	})

	const streamed = await (async () => {
		const messages = readUIMessageStream({
			stream: toUIMessageStream({ stream: result.stream }),
			terminateOnError: true,
		})
		let saved: UIPart[] = []
		for await (const message of messages) {
			const tx = server.transact()
			saveParts(tx, reply, saved, message.parts)
			saved = message.parts
			await server.commit(tx)
		}
	})().catch((cause) => new Error(`Reply ${id} failed`, { cause }))

	clearInterval(heartbeat)
	runs.destroy()
	if (streamed instanceof Error) await saveStatus("error")
	else await saveStatus(controller.signal.aborted ? "stopped" : "complete")
}
```

Pass `tools` to `streamText` as usual: a tool part is set again each time its call streams, resolves, or fails. `saveParts` never removes a part, because a `UIMessage` stream only adds parts or changes them in place.

An abort ends the loop without throwing, so the signal decides between `"complete"` and `"stopped"`. A model error throws because of `terminateOnError`; snapshots still queued at that moment are dropped, so the saved text can end a few tokens before the error.

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

Run one `TandemServer` process for the chat. Live records come from the process that committed, so a client whose pokes and pulls reach different processes falls back to a poke and a pull per batch.

## Client

The client needs the same schema and relations as the server, because it reads parts through the `parts` relation:

```ts
import { TandemClient } from "@tanishqkancharla/tandem-core"

const client = new TandemClient({ schema, relations, remote })
```

Here `remote` is the client's transport to the server's handlers ([Custom remotes](custom-remote.md)). In a single process, such as a test, it can be the server-side `remote` above.

Send a message and its text part in one commit:

```ts
const message: Message = {
	id: messageId,
	threadId,
	role: "user",
	status: "complete",
	createdAt: Date.now(),
	updatedAt: Date.now(),
}
const tx = client.transact()
tx.set("messages", message)
tx.set("parts", toPartRecord(message, 0, { type: "text", text }))
await client.commit(tx)
```

Read the thread with a plain query ordered by `createdAt`, including each message's parts by `index`, and branch on `status`. Without `orderBy`, the order is unspecified. A `"streaming"` reply that the server has not saved for a while belongs to a crashed process:

```tsx
const messages = useTandemQuery({
	collection: "messages",
	where: { threadId },
	orderBy: { createdAt: "asc" },
	with: { parts: { orderBy: { index: "asc" } } },
})

const stale = (message: Message) =>
	message.status === "streaming" && Date.now() - message.updatedAt > 15_000

return messages?.map((message) =>
	message.status === "error" || stale(message) ? (
		<Failed key={message.id} message={message} />
	) : (
		<Bubble
			key={message.id}
			parts={message.parts.map(fromPartRecord)}
			streaming={message.status === "streaming"}
		/>
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

- Subscribe to the open thread only. Each viewer still pulls its whole scan window about once a second while a reply streams.
- Every viewer of the thread sees the reply grow, not only the sender.
- A text part is resent whole only when something other than its text changes, such as its `state` at the end.

The end-to-end test in [`examples/agent-chat/apps/server/test/AgentChat.e2e.spec.ts`](../examples/agent-chat/apps/server/test/AgentChat.e2e.spec.ts) implements this guide with the AI SDK's mock model, and shows a test setup (a silent logger, `syncInterval: 0`, and a JSON transport): two viewers with slow pulls and a long reply, a tool call, the stop button, a model error, send order, and startup cleanup.
