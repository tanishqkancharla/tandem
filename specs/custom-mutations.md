# Shared custom mutations

Status: implemented in draft PR #74. This spec describes the final API and the current replay limit.

## Problem overview

A raw operation push describes record changes but cannot express why they occurred. Apps that need authorization and server work after a commit otherwise have to inspect operations in transport code. Streaming chat also needs each model delta appended without starting another response.

## Solution overview

A shared mutator owns transactional database logic. Both the client and server import it. The client runs it optimistically and persists its name, JSON arguments, and recorded operations; the server validates the arguments and runs the shared function again. The server registration can add `authorize` and `afterCommit` next to that definition. Only the server can run the hooks.

```ts
// shared/mutations.ts
export const appendReply = defineMutator(schema, {
  args: z.object({ id: z.string(), text: z.string() }),
  run: (tx, { id, text }) => tx.append("messages", id, { text }),
})

export const mutators = { appendReply }

// server, for one authenticated request
const registered = {
  appendReply: {
    ...appendReply,
    authorize: (_tx, _args) => {
      if (!serverOwned) throw new Error("Only the server appends replies")
    },
    afterCommit: ({ id }) => notifyReply(id),
  },
} satisfies ServerMutatorsFor<ChatSchema, {}, typeof mutators>
await tandem.push(request, { mutators: registered })
await tandem.mutate("appendReply", { id: replyId, text: delta }, { mutators: registered })

// client
const client = new TandemClient({ schema, mutators, remote })
await client.ready
await client.mutate.appendReply({ id: replyId, text: "Hello" })
```

`defineMutators(schema, { name: { args, run } })` remains the compact form for a module with several definitions. `defineMutator` gives a separate file the same inferred transaction and argument types. Both definitions reject `authorize` and `afterCommit`, including hooks supplied by a spread. The server registration is an ordinary object; it does not replace `run`.

```mermaid
sequenceDiagram
  participant UI
  participant C as TandemClient
  participant H as Tab leader, if coordinated
  participant S as TandemServer
  UI->>C: mutate.name(args)
  C->>C: validate, run shared function, persist call and optimistic ops
  C->>H: forward name, args, and ops
  H->>S: push name and args
  S->>S: validate, authorize, run shared function, commit and acknowledge
  S-->>UI: start afterCommit work
  S-->>C: push response and poke
  C->>C: pull and reconcile pending operations
```

A rejected call is acknowledged without its writes. The client call rejects with `MutationRejectedError`, and a confirming pull removes its optimistic result. Raw operation pushes are refused when server mutators are supplied unless `allowOps: true` is set.

## Goals

- Shared, typed transactional logic and typed optimistic client calls.
- Request authorization before commit with transaction reads and session data.
- Best effort effects after a successful server commit, deduplicated across retried pushes in one server process.
- Named append for server streams without losing the server append delta path.
- Named calls survive client storage and coordinated tab forwarding.

## Limits

- A pending client mutation replays its recorded operations after a pull; Tandem does not rerun its function on rebase. The client append adapter therefore records a full field update. Its optimistic value can temporarily cover a newer live append until confirmation. The server runs the append against its current value at commit and supplies the final authoritative text.
- `afterCommit` is best effort and in memory. A crash after commit can lose an effect. A durable record and startup recovery remain the app's responsibility for work that must finish.
- A lost push response can reject a call even though its server transaction committed. Retry deduplication prevents repeating its writes or effect.

## ✅ Phase 1: Shared client definitions

**Today**

Clients can commit raw operations without a named business action.

**Proposed**

A shared definition validates JSON arguments, runs against typed collection operations, and records the call beside the optimistic operations.

```changes
4847cd4
```

```callstack
 TandemClient.mutate.name [[4847cd4:packages/core/src/TandemClient.ts#L291-L353]]
+├── validateMutatorArgs [[4847cd4:packages/core/src/mutator/Mutator.ts#L149-L174]] # validate the copied arguments
+├── clientMutatorTransaction [[4847cd4:packages/core/src/mutator/Mutator.ts#L176-L204]] # adapt synchronous reads and append
+└── SyncEngine.commit [[4847cd4:packages/core/src/sync/SyncEngine.ts#L558-L592]] # persist name, arguments, and recorded writes
```

```ts
const args = await validateMutatorArgs(name, definition.args, copiedInput)
const tx = client.transact()
await definition.run(clientMutatorTransaction(tx), args, { location: "client" })
await syncEngine.commit(tx, { name, args: copiedInput })
```

## ✅ Phase 2: Server hooks and direct calls

**Today**

A push of raw writes cannot authorize a business action or start work after it commits.

**Proposed**

The server validates and authorizes the named call, always runs the shared function, commits it with the acknowledgement, then starts the registered effect. Direct server calls use the same execution and hooks.

```changes
4847cd4
```

```callstack
 TandemServer.push [[4847cd4:packages/server/src/TandemServer.ts#L433-L447]]
+└── applyMutator [[4847cd4:packages/server/src/TandemServer.ts#L635-L691]]
+    ├── authorize # read the transaction and request session
+    ├── run # execute shared database logic
+    ├── commitTransaction # commit writes and acknowledgement together
+    └── runEffect # start best effort work after commit
 TandemServer.mutate [[4847cd4:packages/server/src/TandemServer.ts#L373-L414]]
+└── run shared definition and hooks # server owned streaming call
```

```ts
const authorized = await definition.authorize?.(tx, args, context)
if (authorized instanceof Error) return authorized
const result = await definition.run(tx, args, context)
if (result instanceof Error) return result
const committed = await commitTransaction(tx)
if (committed instanceof Error) return committed
if (definition.afterCommit) runEffect(() => definition.afterCommit!(args, context))
```

## ✅ Phase 3: Coordinated tabs and named append

**Today**

A tab leader forwards operations, and a server append is available only on a server transaction.

**Proposed**

The tab protocol retains name and arguments across encoding, outbox persistence, handoff, and leader receipts. Shared `tx.append` uses the server's staged append and live delta path; the client shows an optimistic full field update.

```changes
4847cd4
```

```callstack
 TabSession.commit [[4847cd4:packages/core/src/tabs/TabSession.ts#L129-L144]]
+├── TabCodec.encodeMutation [[4847cd4:packages/core/src/tabs/TabProtocol.ts#L76-L105]] # keep the named call
+└── TabHub.commit [[4847cd4:packages/core/src/tabs/TabHub.ts#L385-L457]] # forward it to SyncEngine
 TandemServerTransaction.append [[4847cd4:packages/server/src/TandemServerTransaction.ts#L238-L260]]
+└── TandemServer.commitTransaction [[4847cd4:packages/server/src/TandemServer.ts#L816-L870]] # emit append delta pokes
```

```ts
const mutation = { id, ops, mutator: { name, args } }
leader.syncEngine.commit(replayOps(mutation.ops), mutation.mutator, tabReceipt)
```

## ✅ Phase 4: Consumer and simulation verification

**Today**

The exploratory agent chat manually filters operations and writes full reply snapshots. DST generates only raw client mutations.

**Proposed**

The chat example starts one response from `sendMessage.afterCommit` and invokes `appendReply` for every text delta. DST generates named appends, traces and replays them, and checks final server/client text and effect repetition under network faults and crashes.

```changes
4847cd4
```

```callstack
 ChatServer.startReply [[4847cd4:examples/agent-chat/apps/server/test/AgentChatMutators.e2e.spec.ts#L176-L184]]
+└── ChatServer.streamReply [[4847cd4:examples/agent-chat/apps/server/test/AgentChatMutators.e2e.spec.ts#L185-L232]]
+    └── TandemServer.mutate(appendReply) # one named append per delta
 DstSimulation.choose [[4847cd4:dst/DstSimulation.ts#L154-L284]]
+└── DstWorld.writeNamedAppend [[4847cd4:dst/DstWorld.ts#L1288-L1321]] # exercise the public client call
```

```ts
for await (const delta of result.textStream)
  await tandem.mutate("appendReply", { id, text: delta }, { mutators: serverMutators })
```

## ✅ Phase 5: Offset page scan-window repair

**Today**

A sole offset subscription can cache only the requested page. The local query applies the offset again and returns an empty result. This pre-existing defect also fails the scoped CI sweep.

**Implemented**

Pull scan windows include the matching prefix through `offset + limit`; the client applies the original query to those records. Live-poke membership still uses the requested page and offset shifts trigger a pull without sending prefix details. DST keeps a broad offset subscription in scoped sweeps and asserts the nonempty page through the public client API.

```changes
78e0ad4
```

```callstack
 TandemServer.readPull [[78e0ad4:packages/server/src/TandemServer.ts#L768-L785]]
+└── executeScanWindowAsync [[78e0ad4:packages/core/src/query/executeQuery.ts#L607-L620]]
+    └── collectScanWindow → windowQueryPrefix [[78e0ad4:packages/core/src/query/executeQuery.ts#L546-L601]] # include rows before the offset
 TandemServer.emitLivePokes [[78e0ad4:packages/server/src/TandemServer.ts#L923-L956]]
+├── selectScanWindowRecordsAsync [[78e0ad4:packages/core/src/query/executeQuery.ts#L640-L677]] # check the original page
+└── pokeClient # ask the client to pull when an offset page shifts
```

## References

- [Agent chat guide](../docs/agent-chat.md)
- [Append and batching](append-and-batching.md)
- [Deterministic simulation testing](deterministic-simulation-testing.md)
