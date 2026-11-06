# Build streaming chat

A shared append mutation can receive text from a browser client, from a server-hosted client SDK, or directly from server code. In every case, the server commits the final record and subscribed clients receive live pokes followed by a confirming pull.

The runnable [agent chat test](https://github.com/tanishqkancharla/tandem/blob/main/examples/agent-chat/apps/server/test/AgentChatMutators.e2e.spec.ts) uses the server process to generate a reply. It covers a lost push response, a stop request, authorization, and the final text.

## Shared append definition

Import this definition on both client and server. It reads the current message and writes the extended record. `args` validates the text before either side runs it.

```ts
const appendArgs = z.object({ id: z.string(), text: z.string() })
const appendReply = defineMutator(schema, {
	args: appendArgs,
	run: async (tx, { id, text }) => {
		const message = await tx.get("messages", id)
		if (!message) return
		tx.set("messages", { ...message, text: message.text + text })
	},
})
const sendMessage = defineMutator(schema, {
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
			id: `${messageId}:reply`,
			threadId,
			role: "assistant",
			text: "",
			status: "streaming",
			updatedAt,
		})
	},
})
const finishReply = defineMutator(schema, {
	args: z.object({ id: z.string(), status: z.enum(["complete", "error"]) }),
	run: async (tx, { id, status }) => {
		const reply = await tx.get("messages", id)
		if (reply) tx.set("messages", { ...reply, status, updatedAt: Date.now() })
	},
})
```

The server serializes named mutations, so concurrent calls read the latest committed text. Its sync path derives compact append pokes when the final record differs only by string growth and the field codec can represent the suffix. Other changes, such as a status change, send a bare poke, and viewers pull the record. A pending client call replays its recorded set during rebase, so its optimistic text can briefly cover newer live text until the confirming pull.

## Register the server once

The constructor retains the shared registry's names and argument types. A hooks factory receives the session supplied by the authenticated push transport. It runs for each named call, and an asynchronous `afterCommit` closes over that call's session. The server sets `ctx.source`; clients cannot choose it.

The wrappers below show mutation routing. They delegate reads and connections directly, so they require a separate access boundary before use with untrusted callers. Follow [Permissions](permissions.md) to enforce thread read access, bind client IDs, and end streams when access changes.

```ts
const mutators = { appendReply, sendMessage, finishReply }
function createChatServer(
	generation: "client" | "server",
	streamReply: (id: string, threadId: string) => Promise<void>,
) {
	return new TandemServer({
		schema,
		relations: {},
		storage,
		mutators,
		hooks: (session: Session | undefined) => ({
			appendReply: {
				authorize: async (tx, { id }, ctx) => {
					const message = await tx.get("messages", id)
					if (
						!message ||
						!id.endsWith(":reply") ||
						message.status !== "streaming"
					)
						return new Error("No streaming reply")
					if (
						generation === "server"
							? ctx.source !== "server"
							: ctx.source !== "client" ||
								!session?.threads.includes(message.threadId)
					)
						return new Error("No access")
				},
			},
			sendMessage: {
				authorize: async (tx, { messageId, threadId }, ctx) => {
					if (ctx.source !== "client" || !session?.threads.includes(threadId))
						return new Error("No access")
					if (
						(await tx.get("messages", messageId)) ||
						(await tx.get("messages", `${messageId}:reply`))
					)
						return new Error("Message exists")
				},
				afterCommit:
					generation === "server"
						? ({ messageId, threadId }) =>
								streamReply(`${messageId}:reply`, threadId)
						: undefined,
			},
			finishReply: {
				authorize: async (tx, { id }, ctx) => {
					const reply = await tx.get("messages", id)
					if (
						generation !== "client" ||
						ctx.source !== "client" ||
						!reply ||
						!id.endsWith(":reply") ||
						reply.status !== "streaming" ||
						!session?.threads.includes(reply.threadId)
					)
						return new Error("No access")
				},
			},
		}),
	})
}

const server = createChatServer("client", async () => {}) // use "server" for direct calls

const remote: RemoteApi<ChatSchema> = {
	push: (request) => server.push(request, { context: authenticatedSession }),
	pull: (request) => server.pull(request),
	connect: (client) => server.connect(client),
}
```

`sendMessage` is a separate shared mutation that creates the user message and one empty reply. In client mode, `finishReply` sets the reply's terminal status through a shared mutation. In server mode its hook refuses every call, and server code sets the status with a server transaction, which runs no hooks; see [Option 2](#option-2-server-code-mutates-tandemserver-directly). Only server mode installs the `sendMessage.afterCommit` generation hook; append calls do not retrigger it. A retried push keeps the same mutation ID and does not start a second response. The [runnable test](https://github.com/tanishqkancharla/tandem/blob/main/examples/agent-chat/apps/server/test/AgentChatMutators.e2e.spec.ts) shows the complete definitions, both streaming paths, and stop behavior.

## Receive updates in a client

Subscribe to the thread before expecting another writer's records. The subscription builds the client's scan window; the remote connection then receives live pokes and confirming pulls.

```ts
const client = new TandemClient({ schema, mutators, remote })
await client.ready
const subscription = client.subscribe(
	{ collection: "messages", where: { threadId } },
	(messages) => render(messages.map(({ text, status }) => ({ text, status }))),
)
// Later: subscription.destroy()
```

A client outside the scan window can call `pullFromRemote()` to fetch a new view after changing its subscriptions.

## Option 1: server code streams through a TandemClient

Construct the server with `createChatServer("client", async () => {})`. A server process creates a headless `TandemClient` with in-memory state and `tabs: false`. Its authenticated remote routes calls through client sync, so `ctx.source` is `"client"` and the session must have access to the thread. The server process consumes the model stream; its client SDK performs optimistic appends and sync. Other subscribed clients receive the committed text and terminal status.

```ts
const headlessRemote: RemoteApi<ChatSchema> = {
	push: (request) => server.push(request, { context: serviceSession }),
	pull: (request) => server.pull(request),
	connect: (client) => server.connect(client),
}
const headless = new TandemClient({
	schema,
	mutators,
	remote: headlessRemote,
	tabs: false,
}) // no clientStorage: in-memory client state
await headless.ready
const thread = headless.subscribe({
	collection: "messages",
	where: { threadId },
})
await headless.pullFromRemote()
await headless.mutate.sendMessage({ messageId, threadId, text: prompt })
const id = `${messageId}:reply`
try {
	const stream = streamText({ model, messages: await threadContext(threadId) })
	for await (const delta of stream.textStream)
		await headless.mutate.appendReply({ id, text: delta })
	await headless.mutate.finishReply({ id, status: "complete" })
} catch (error) {
	await headless.mutate.finishReply({ id, status: "error" })
	throw error
} finally {
	thread.destroy()
	await headless.disconnect()
}
```

This path is useful when the stream reader lives on a server but should use the same client mutation and sync behavior as a browser. Use a session issued by the server transport for the service's allowed threads.

## Option 2: server code mutates TandemServer directly

Construct the server with `createChatServer("server", streamReply)`. A client calls `sendMessage` once. Its `afterCommit` starts the stream and returns its promise. The server runs the hook inside the mutation queue but does not await the promise, and it logs a rejection. The server code consumes the model stream and calls typed `server.mutate.appendReply` for each chunk. These calls have `ctx.source === "server"`; the server controls this value. Subscribed clients receive the committed text and terminal status.

```ts
async function streamReply(id: string, threadId: string) {
	const stream = streamText({ model, messages: await threadContext(threadId) })
	for await (const delta of stream.textStream)
		await server.mutate.appendReply({ id, text: delta })
	const tx = server.transact()
	await tx.update("messages", id, { status: "complete" })
	await server.commit(tx)
}
```

The runnable test uses this direct path. It records `"stopped"` when a `stopReply` mutation aborts generation, and `"error"` when generation fails. The `afterCommit` hook is best effort and in memory; persist and recover work separately if a response must survive a server crash.

## Option 3: the client reads the model stream

A browser or other client starts generation and consumes its own model stream. Construct the server with `createChatServer("client", async () => {})`, so `sendMessage` creates an empty reply without a server generation hook. The append hook permits a client with access to the reply's thread. Each append is optimistic locally and syncs to other subscribed clients.

```ts
await client.mutate.sendMessage({ messageId, threadId, text: prompt })
const replyId = `${messageId}:reply`
const stream = await startModelStream({ threadId, prompt })
for await (const delta of stream.textStream) {
	await client.mutate.appendReply({ id: replyId, text: delta })
}
await client.mutate.finishReply({ id: replyId, status: "complete" })
```

The client owns the generation in this option. On a stream error, call `finishReply` with `status: "error"`. Keep model credentials in a trusted service when the provider requires them; `startModelStream` can read an authenticated response stream from that service.
