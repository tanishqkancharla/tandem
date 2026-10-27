# Agent chat with shared mutations

Tandem can show a model reply as text arrives. A shared mutation creates the user message and an empty reply optimistically. Its server registration authorizes the request and starts one model response after commit. Each model text delta invokes a separate named append directly on the server. Tandem's live append pokes carry the deltas to subscribed clients; clients confirm them with a pull.

The runnable example is [AgentChatMutators.e2e.spec.ts](../examples/agent-chat/apps/server/test/AgentChatMutators.e2e.spec.ts). It covers a lost push response, unauthorized and forged writes, a stop request, and the final reply text.

## Shared definitions

Keep executable definitions in modules imported by both client and server. A schema describes the records; it does not need to contain the functions.

```ts
const sendMessage = defineMutator(schema, {
  args: z.object({ messageId: z.string(), threadId: z.string(), text: z.string().min(1) }),
  run: (tx, { messageId, threadId, text }) => {
    tx.set("messages", { id: messageId, threadId, role: "user", text, status: "complete" })
    tx.set("messages", { id: `${messageId}:reply`, threadId, role: "assistant", text: "", status: "streaming" })
  },
})

const appendReply = defineMutator(schema, {
  args: z.object({ id: z.string(), text: z.string() }),
  run: async (tx, { id, text }) => {
    const message = await tx.get("messages", id)
    if (message) tx.set("messages", { ...message, text: message.text + text })
  },
})

const mutators = { sendMessage, appendReply }
```

The example includes `updatedAt` and a `stopReply` mutation; the snippets here show the write path. The shared function reads and extends the current record in each client and server transaction. Server named calls run in commit order; the sync path derives compact delta pokes when the committed change is only string growth. The custom mutations spec (`specs/custom-mutations.md`) describes the resulting pending rebase limit.

## Server registration

Register server hooks beside the shared definitions for each request. `authorize` reads the transaction and captures the authenticated session. The shared `run` then executes automatically. `afterCommit` starts model work only when that transaction commits. A retried push is skipped by the server's mutation ID dedupe and does not start a second response.

```ts
function serverMutators(session: Session, serverOwned = false) {
  return {
    sendMessage: {
      ...sendMessage,
      authorize: async (tx, { messageId, threadId }) => {
        if (!session.threads.includes(threadId)) throw new Error("No access")
        if (await tx.get("messages", messageId)) throw new Error("Message exists")
      },
      afterCommit: ({ messageId, threadId }) => startReply(`${messageId}:reply`, threadId),
    },
    appendReply: {
      ...appendReply,
      authorize: () => {
        if (!serverOwned) throw new Error("Only the server appends replies")
      },
    },
  } satisfies ServerMutatorsFor<ChatSchema, {}, typeof mutators>
}

const remote = {
  push: (request) => tandem.push(request, { mutators: serverMutators(session) }),
  pull: (request) => tandem.pull(request),
  connect: (client) => tandem.connect(client),
}
```

Passing `mutators` makes the server refuse raw operation pushes by default. `stopReply` can use a shared no-op `run` with a server `authorize` check and an `afterCommit` hook that aborts the active model controller.

## Reply loop

A post-commit hook must return promptly. It starts the reply loop without awaiting the model or another server mutation inside the transaction queue. The loop calls the registered append mutation for each delta, then saves a terminal status.

```ts
async function streamReply(id: string, threadId: string) {
  const result = streamText({ model, messages: await threadContext(threadId) })
  for await (const delta of result.textStream) {
    await tandem.mutate("appendReply", { id, text: delta }, {
      mutators: serverMutators({ threads: [threadId] }, true),
    })
  }
  const tx = tandem.transact()
  await tx.update("messages", id, { status: "complete" })
  await tandem.commit(tx)
}
```

Subscribe before expecting updates from another client. A client that is not subscribed to the thread can call `pullFromRemote()` to fetch it. For work that must survive a server crash, persist a reply state and recover unfinished replies at startup; `afterCommit` itself is best effort and in memory.
