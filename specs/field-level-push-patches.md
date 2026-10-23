# Field-level updates inside transactions

## Problem overview

`Transaction.update` currently calls an updater that returns a complete record and records the result as a `set`. The outbox, push request, server application, and client replay therefore treat an update as a whole-record replacement. Two clients editing different fields can overwrite each other's edits.

```callstack
 Transaction.update [[packages/core/src/transaction/Transaction.ts#Transaction.update]]
 ├── read the transaction-visible record
 ├── call the updater and stage its complete result
 └── append a set operation containing every field
 Database.commitMutation [[packages/core/src/Database.ts#Database.commitMutation]]
 └── commit records, sparse bases, ordered outbox, and replica counter together
 SyncEngine.push [[packages/core/src/sync/SyncEngine.ts#SyncEngine.push]]
 └── send the stored operations after flushing local storage
 TandemServer.applyPush [[packages/server/src/TandemServer.ts#TandemServer.applyPush]]
 └── replace records and commit the mutation acknowledgement
```

Changing only the push payload does not fix this. `Database.applyPull` restores each tracked record's confirmed base and replays pending operations. Replaying a stale full record can still hide a concurrent edit locally, even if the server merges fields correctly.

## Solution overview

The agreed direction is an explicit partial-object update inside a transaction. The supplied keys describe the write intent; Tandem does not compare before and after records to discover changed fields. Keep the durable ordered outbox, sparse bases, and pull-driven acknowledgement design.

```tsx
const tx = client.transact()
tx.update("todos", "todo-1", { done: true })
tx.update("todos", "todo-2", { title: "Buy tea" })
await client.commit(tx)

// Starting record: { id: "todo-1", title: "Buy milk", done: false }
// Client A assigns { done: true }; client B assigns { title: "Buy bread" }.
// Either server application order produces:
// { id: "todo-1", title: "Buy bread", done: true }
```

Both server application and local replay merge an update into the record visible at that point in operation order. Neither uses an old full record as the replacement. Application callbacks are not persisted or rerun.

The operation carries a partial `payload`. The schema owns serialization through one partial object codec, defined directly from field codecs. Use that same collection codec for records, confirmed bases, set values, and update payloads. No separate complete-record codec, derived update codec, or exposed codec source is needed.

Phases one and two are committed locally. `partialObject` is the collection codec contract; storage, server push application, and replay support update operations. JSON transports encode and decode push mutations at the wire boundary; `TandemServer` applies runtime values without repeating collection codec calls. Public transaction updates still accept callbacks and produce sets; phases three and four remain planned.

Field-removal semantics still need alignment. Object-owned updater methods are a possible future API, not part of this implementation.

## Goals

- Preserve concurrent assignments to different top-level fields, including while a local update is pending during a pull.
- Push only explicitly assigned or removed fields for an update.
- Keep atomic local checkpoints, mutation IDs, duplicate suppression, and ordered replay across restart.
- Give client and server transactions the same update semantics, while retaining their synchronous and asynchronous read differences.

## Non-goals

Deep merges, CRDTs, per-field clocks, atomic increments, object-method registration or replay, and serializable transactions across offline clients are outside this change. Pull responses remain full-record patches. `set` remains a whole-record create or replacement. No outbox coalescing, acknowledgement redesign, new whole-record validation framework, or old-checkpoint compatibility layer is planned.

## Proposed semantics to align on

| Case                                          | Proposed behavior                                                                              |
| --------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `update(collection, id, { done: true })`      | Assign only `done`; preserve other fields.                                                     |
| Omitted property                              | Leave it untouched.                                                                            |
| Explicit assignment equal to the local value  | Still record intent; a remote value may differ.                                                |
| Nested object or array                        | Replace that top-level field; do not recursively merge.                                        |
| `null`                                        | Assign `null` when the field type permits it.                                                  |
| Explicit `undefined`                          | Remove an optional property; encode removal explicitly on the wire. This rule needs agreement. |
| `id` in the partial object                    | Reject it; identity is not an editable field.                                                  |
| Empty partial object                          | Add no update operation; leave existing empty-transaction mutation-ID behavior unchanged.      |
| Record missing locally                        | No-op, matching today's update-only behavior. It cannot update an unseen server record.        |
| Record missing on the server or during replay | No-op; do not resurrect it. The server still acknowledges a successfully processed mutation.   |
| Multiple operations on one record             | Apply in original order; reads see earlier staged writes.                                      |
| Concurrent writes to the same field           | The later server-applied assignment wins, regardless of client wall-clock time.                |

The recommendation is to replace the callback-returning-record update API, rather than keep two interpretations of `update`. Tandem is unreleased; existing callers can migrate to explicit partial objects. This is an alignment decision, not a compatibility requirement.

Transaction reads still produce captured assignments, not deferred server computation:

```tsx
const tx = client.transact()
const todo = tx.get("todos", "todo-1")
if (todo) tx.update("todos", todo.id, { count: todo.count + 1 })
await client.commit(tx)

// If two clients both read count = 0, both send count = 1.
// The eventual count is 1, not 2. Replay does not rerun this code.
```

### Update operation

Use the operation itself to express field intent. The payload contains only explicitly supplied assignments, never a diff computed from two records.

```tsx
// Implemented protocol shape; public transaction calls change in phase three.
const update = {
	type: "update",
	collection: "todos",
	id: "todo-1",
	payload: { done: true },
}

// Server application and replay both merge into the current record.
function applyUpdate(current, operation) {
	if (!current) return undefined
	return { ...current, ...operation.payload }
}
```

The merge above illustrates assignment only. If field removal is included, it needs a separate representation: JSON does not preserve `undefined`. An explicit `unset` list remains a proposal, not a settled part of the operation shape.

### One collection codec handles records and update payloads

Define the collection codec directly with `partialObject(fields)`. Its ordinary `encode` and `decode` methods visit supplied properties, apply their field codecs, and leave omitted properties absent. A record containing every field and an update containing one field both use this same codec. Nested values use their declared field codec; partial-object encoding does not imply deep update merging.

```tsx
// Implemented in phase one; update payload persistence is implemented in phase two.
const eventCodec = partialObject({ id: string, title: string, startAt: date })

eventCodec.encode({ id: "event-1", title: "Meeting", startAt: nextDate })
// → All three supplied fields; startAt becomes an ISO string.

eventCodec.encode({ startAt: nextDate })
// → { startAt: "2026-10-23T12:00:00.000Z" }

eventCodec.decode({ startAt: "2026-10-23T12:00:00.000Z" })
// → { startAt: Date(...) }; no title or id is manufactured.
```

The schema provides this one codec to the storage adapter. Persist the partial update payload itself, not a full record plus a field mask. Restore custom field values when loading the outbox before replay or delivery.

Partialness is an explicit codec contract, not a second encoding mode. Supplied fields retain their individual validation; the codec does not guarantee that omitted fields exist or enforce cross-field invariants. The collection still requires identity when writing records and forbids identity changes in update payloads. Types inferred from the partial codec must reflect potentially absent non-ID fields, rather than claim decoding proves a complete record.

Collection serialization must satisfy this partial-safe contract. Migrate whole-record custom transformations into field codecs rather than introspecting or bypassing opaque whole-object behavior. No automatic whole-object validation is promised by this codec.

Keep the existing transport boundary: `RemoteApi` carries runtime values. A JSON transport uses `MutationApi.codec(schema)` to encode push mutations before serialization and decode them before `server.push`. The sync engine does not substitute storage-encoded values into remote calls. This codec covers push mutations, not pull responses, authentication, or authorization.

### Future methods can produce the same operations

Keep domain behavior above the durable operation format. An application helper can already express a domain action as explicit assignments. A later object-method API could call the same transaction writer without changing the meaning of the persisted update.

```tsx
// First version: application-owned helper, no new method framework.
function completeTodo(tx, id) {
	tx.update("todos", id, { done: true })
}

// Possible later API, not planned implementation:
tx.object("todos", id).complete()
// Could emit the same { type: "update", payload: { done: true }, ... }.
```

This does not preserve arbitrary method intent. A method that reads `count` and assigns `count + 1` still records a captured assignment. Replicating an increment, set insertion, or other domain operation would require an explicitly encoded operation and an agreed application rule, or named-mutator replay. Do not add either extension now or serialize function bodies.

## Implementation

### ✅ Phase 1: Use one partial-object collection codec

Today

Before this phase, `object` already visited only supplied fields at runtime, but its declared output type claimed a complete object. Collection options also accepted opaque whole-record codecs that were not partial-safe.

Proposed

Make partial-object serialization the collection codec contract. Define `partialObject` directly from its field map with partial decoded and encoded output types, and use the resulting single codec everywhere collection values are serialized. Do not introduce a strict object counterpart, a codec-derivation step, or separate record/update configuration.

```changes
f6b65ee
```

The committed constructor transforms supplied fields, while the collection restores the separate record-ID requirement:

```callstack
-object
-└── transform supplied fields but claim a complete output type
+partialObject [[f6b65ee:packages/core/src/utils/Codec.ts#L109-L152]]
+└── accept field codecs and return explicitly partial output types
 collection [[f6b65ee:packages/core/src/schema/Schema.ts#L240-L250]]
-└── accept arbitrary whole-record serialization
+└── infer optional fields and require record identity separately
```

The helper takes field codecs directly, with no metadata from another codec or update-specific methods. The public contract is [[f6b65ee:packages/core/src/utils/Codec.ts#L16-L22]]; its type-only marker preserves the field map's record shape for inference.

```tsx
// Public contract; the type-only record marker is omitted from this sketch.
type PartialObjectCodec<Record, Stored> = Codec<
	Partial<Record>,
	Partial<Stored>
> & {
	readonly kind: "partialObject"
}

type EventRecord = { id: string; title?: string; startAt?: Date }
type EventPayload = { id?: string; title?: string; startAt?: Date }
```

Each supplied property passes through its declared field codec. Omitted properties never reach a field codec, and the same path serves records, bases, and outbox set values:

```diagram
┌─────────────────────────────┐
│ Record or supplied fields   │
└──────────────┬──────────────┘
               ▼
┌─────────────────────────────┐
│ Check object and field name │
└──────────────┬──────────────┘
               ▼
┌─────────────────────────────┐
│ Run declared field codec    │
└──────────────┬──────────────┘
               ▼
┌─────────────────────────────┐
│ Return supplied fields only │
└─────────────────────────────┘
```

The implementation returns its own input errors internally and throws them at the public boundary. Field codecs retain their validation, including for explicit `undefined`; the sketch below shows the observable behavior of [[f6b65ee:packages/core/src/utils/Codec.ts#L115-L150]].

```tsx
function partialObject(fields) {
	function transform(input, direction) {
		assertObjectInput(input)
		const entries = []
		for (const [name, value] of Object.entries(input)) {
			assertKnownField(fields, name)
			entries.push([name, fields[name][direction](value)])
		}
		return Object.fromEntries(entries)
	}

	// Declared outputs are Partial<DecodedRecord> and Partial<EncodedRecord>.
	return {
		kind: "partialObject",
		encode: (input) => transform(input, "encode"),
		decode: (input) => transform(input, "decode"),
	}
}
```

Applications declare one codec. The collection handles record identity separately because an update payload need not contain an ID. Codec-inferred collection records have required, non-null identity and optional non-ID fields.

Shape-based and explicitly typed collection declarations retain their declared record types. Partial-object serialization does not add whole-record validation:

```tsx
const eventCodec = partialObject({ id: string, title: string, startAt: date })
const schema = defineSchema({ events: collection({ codec: eventCodec }) })

const storedRecord = eventCodec.encode({ id: "event-1", startAt: nextDate })
const storedPayload = eventCodec.encode({ startAt: nextDate })
// The same field rules apply to both inputs; omitted title stays absent.
const restoredPayload = eventCodec.decode(storedPayload)
// startAt is restored as Date, with no manufactured title or id.

// Codec-inferred record: { id: string; title?: string; startAt?: Date }.
// A collection codec without a valid id field is a TypeScript error.
// A transaction set still requires a record id, even though encode({}) is valid.
```

The existing persistence scenarios put custom `EventStart` conversion in its field codec at [[f6b65ee:packages/core/test/persistence.spec.ts#L48-L57]]. Records, confirmed bases, and outbox set values round-trip through the same collection codec. Phase one does not add an update outbox operation.

Verification passes: `pnpm type-check`, `pnpm test` (99 core tests and 75 tests across the other packages, including cached Gatekeeper coverage), and `pnpm lint`. [[f6b65ee:packages/core/test/schema-api.spec.ts#L23-L202]] covers partial output inference, omitted fields, round trips, nested validation, rejected input, and collection identity. Existing persistence and replay tests remain green; concurrent field preservation needs the later operation, replay, and transaction phases.

### ✅ Phase 2: Carry field intent through storage, push, server application, and replay

Today

Before this phase, `MutationOp` contains only `set` and `remove`, and the same operation type describes local outbox and wire values. The IndexedDB codec handles only complete set values. Replay and server push apply whole-record operations.

Proposed

Add an update operation carrying a partial payload, preserving set/remove behavior. Use the same schema-owned codec to persist update payloads and serialize push mutations at transport boundaries. Establish the protocol and replay foundation before exposing the new application API.

```changes
d530fc3..5556788
```

The committed [[d530fc3..5556788:packages/core/src/transaction/Transaction.ts#L99-L122]] stores captured assignments, not an updater callback or old record. Its collection name determines both the identity and payload types:

```tsx
type UpdateMutationOp<Schema extends AnySchema> = {
	type: "update"
} & {
	[Collection in CollectionName<Schema>]: {
		collection: Collection
		id: Schema[Collection]["id"]
		payload: Partial<Omit<Schema[Collection], "id">> & { id?: never }
	}
}[CollectionName<Schema>]

type Mutation<Schema extends AnySchema> = {
	id: MutationId
	ops: (
		| SetMutationOp<Schema>
		| RemoveMutationOp<Schema>
		| UpdateMutationOp<Schema>
	)[]
}
```

Collection codecs validate and transform supplied fields during storage encoding/decoding and transport serialization/deserialization. `TandemServer` does not repeat that validation when applying runtime operations. The update operation separately forbids identity changes.

Collection codecs remain optional. Without one, values pass through the mutation codec; a JSON transport needs JSON-native values or its own validation. The server still rejects non-object update payloads and identity changes, but does not validate field types. Field removal remains unresolved: accepted runtime `undefined` is an assignment, not deletion, and JSON drops it; no `unset` representation is added here.

Storage and push gain one operation branch while keeping the current durable-delivery barrier:

```callstack
 createTupleCodec [[d530fc3..5556788:packages/core/src/clientStorage/TandemClientIndexedDbStorage.ts#L64-L147]]
 └── transform outbox operations in order
-    └── run collection codecs only for set values
+    └── run the same collection codec for set values and update payloads
 SyncEngine.push [[packages/core/src/sync/SyncEngine.ts#SyncEngine.push]]
 ├── build the request from ordered outbox operations
+│   └── include update payloads containing only explicit assignments
 ├── flush the captured mutation checkpoint
 └── retain the existing session check before delivery
```

At the storage boundary, operation type selects which value to transform, not which codec to use. The same dispatch serves encoding and decoding. This is a sketch of the outbox branch for a configured collection codec, not a replacement for the adapter's existing atomic batch handling.

```tsx
function transformOutboxOperation(operation, direction, schema) {
	const valueCodec = schema.collections[operation.collection].codec
	if (!valueCodec) return operation
	switch (operation.type) {
		case "set":
			return { ...operation, value: valueCodec[direction](operation.value) }
		case "update":
			return {
				...operation,
				payload: valueCodec[direction](operation.payload),
			}
		case "remove":
			return operation
	}
}
```

Push captures the pending operations in order and waits for the existing durable checkpoint barrier before delivery. Receiving a successful push response does not remove anything from the outbox.

```diagram
┌─────────────────┐     ┌──────────────────┐     ┌──────────────────┐
│ Local checkpoint│────▶│ Push ordered ops │────▶│ Server commit    │
└────────▲────────┘     └──────────────────┘     └────────┬─────────┘
         │                                                │
         │              ┌──────────────────┐              │
         └──────────────│ Pull ack + replay│◀─────────────┘
                        └──────────────────┘
```

The push sketch flushes the captured checkpoint before delivery and leaves pruning to pull:

```tsx
async function pushPending() {
	const clientId = database.replica.clientId
	const mutations = readPendingMutationsInOrder(database)
	if (mutations.length === 0) return

	const flushed = await database.flushClientStorage()
	if (flushed instanceof Error) return flushed
	if (clientId !== database.replica.clientId || !connected) return
	return remote.push({ clientId, mutations })
	// Only applyPull prunes acknowledged mutations.
}
```

The JSON transport encodes mutations before serialization and decodes the entire push request before calling the server. A decoding failure returns HTTP 400 `invalid-request` without applying or acknowledging any request prefix. This changes the previous JSON cast into a schema-owned deserialization step:

```callstack
 request [[d530fc3..5556788:examples/todo/apps/web/src/TodoHttpRemote.ts#L22-L53]]
-├── JSON.stringify # serialize runtime operations directly
+├── encode mutation fields with the collection codec [[d530fc3..5556788:packages/core/src/transaction/Transaction.ts#L131-L242]]
+└── JSON.stringify # serialize encoded push mutations
 createTodoApp [[d530fc3..5556788:examples/todo/apps/server/src/app.ts#L125-L146]]
 ├── parse the request JSON
 ├── validateRequest [[d530fc3..5556788:examples/todo/apps/server/src/app.ts#L33-L49]]
-│   └── cast the request after checking its outer envelope
+│   └── decode every mutation before any server writes [[d530fc3..5556788:packages/core/src/transaction/Transaction.ts#L131-L242]]
 └── executeRequest # pass runtime mutations to server.push
```

The exported mutation codec uses the optional collection codec for set values, update payloads, and update/remove identities. It preserves mutation IDs and operation order, rejects malformed mutation envelopes and unknown collections or operation types, and requires a valid runtime record identity after decoding:

```tsx
const mutationCodec = MutationApi.codec(schema)
// Codec<Mutation<Schema>, unknown>; collection field codecs own the wire shape.

// Client transport, before sending JSON:
const body = JSON.stringify({
	clientId,
	mutations: mutations.map((mutation) => mutationCodec.encode(mutation)),
})

// Server transport, after parsing JSON and checking the outer envelope:
const decoded = errore.try(() =>
	request.mutations.map((mutation) => mutationCodec.decode(mutation)),
)
if (decoded instanceof Error) return http400({ error: "invalid-request" })
return server.push({ clientId: request.clientId, mutations: decoded })
```

For an update, the codec transforms both the separate identity and the partial payload. The following sketch shows that branch for a configured codec; set transforms its value, and remove transforms only its identity:

```tsx
function transformUpdate(operation, direction, valueCodec) {
	const identity = valueCodec[direction]({ id: operation.id })
	return {
		...operation,
		id: identity.id,
		payload: valueCodec[direction](operation.payload),
	}
}

// A date field is encoded once by the sending transport and decoded once
// by the receiving transport. Server application receives Date, not a string.
const encoded = mutationCodec.encode({
	id: 1,
	ops: [
		{
			type: "update",
			collection: "events",
			id: 42,
			payload: { startAt: nextDate },
		},
	],
})
// Example custom field codecs produce id: "event-42" and an ISO startAt.
const runtime = mutationCodec.decode(JSON.parse(JSON.stringify(encoded)))
// runtime.ops[0] has id: 42 and payload: { startAt: Date(...) }.
```

Wire rejection happens before server application, whereas storage encoding remains part of local checkpoint persistence. Direct in-process remotes skip the wire conversion and keep runtime values throughout:

```diagram
┌──────────────────┐     ┌───────────────────┐     ┌────────────────────┐
│ Runtime mutation │────▶│ Encode + JSON     │────▶│ Parse + decode all │
└──────────────────┘     └───────────────────┘     └─────────┬──────────┘
                                                           │
                                      ┌────────────────────┤
                                      │ valid              │ invalid
                           ┌──────────▼─────────┐  ┌───────▼────────────┐
                           │ server.push        │  │ HTTP 400           │
                           │ merges runtime ops │  │ No writes or ack   │
                           └────────────────────┘  └────────────────────┘
```

The todo schema now supplies field codecs at [[d530fc3..5556788:examples/todo/packages/shared/src/index.ts#L13-L43]]. Its HTTP transport exercises the public mutation codec; other custom remotes can use the same boundary pattern described in [[d530fc3..5556788:docs/custom-remote.md#L48-L68]]. Pull response serialization and access control remain transport responsibilities.

Keep bases as confirmed full values or explicit absence. Extend record targeting and replay in `Database` for the new operation, without changing which bases are retained or when acknowledgements prune the outbox. Persist records, bases, local operations, and the mutation counter together as today.

```callstack
 Database.applyPull [[d530fc3..5556788:packages/core/src/Database.ts#L337-L375]]
 ├── apply full-record server patches to confirmed bases
 ├── prune acknowledged outbox entries
 ├── restore each tracked record from its base
-├── replay pending set/remove operations in order
+├── replay pending set/remove/update operations in order
+│   └── applyOp # assign supplied fields only when the record exists [[d530fc3..5556788:packages/core/src/Database.ts#L67-L89]]
 └── commit rebuilt records, bases, outbox, and cookie together
```

During replay, operate on decoded runtime values. A pending payload merges into the restored base, not the record captured when the user edited it. The helper names below summarize existing checkpoint steps; they are not proposed new public APIs.

```tsx
function applyPull(response) {
	const tx = database.transact()
	applyServerPatchToRecordsAndBases(tx, response.patch)
	pruneAcknowledgedMutations(tx, response.lastMutationId)
	restoreTrackedRecordsFromBases(tx)

	for (const mutation of pendingMutationsInOrder(tx)) {
		for (const operation of mutation.ops) {
			if (operation.type === "update") {
				const current = readRecord(tx, operation.collection, operation.id)
				if (current !== undefined) {
					stageRecord(tx, operation.collection, {
						...current,
						...operation.payload,
					})
				}
			} else {
				stageSetOrRemove(tx, operation)
			}
		}
	}

	removeAcknowledgedBases(tx, response.lastMutationId)
	stageCookie(tx, response.cookie)
	tx.commit()
}
```

The server reads and merges an update within the same transaction that stores its acknowledgement. Before this phase, its operation loop stages synchronous writes. The implemented loop awaits every operation in sequence so an update sees earlier staged operations.

```callstack
 TandemServer.applyPush [[d530fc3..5556788:packages/server/src/TandemServer.ts#L359-L408]]
 ├── skip duplicate mutation IDs and reject gaps
 ├── open the mutation transaction
-├── applyMutationOperation # stage set/remove writes synchronously
+├── await applyMutationOperation # preserve operation order [[d530fc3..5556788:packages/server/src/TandemServer.ts#L108-L167]]
+│   ├── reject non-object update payloads and identity changes
+│   └── TandemServerTransaction.update # merge into the current record [[packages/server/src/TandemServerTransaction.ts#TandemServerTransaction.update]]
 ├── stage the mutation acknowledgement only after successful operations
 └── commit records and acknowledgement atomically
```

Keep the existing per-mutation atomicity: an error cannot commit part of one mutation or advance its acknowledgement. Earlier mutations in a push batch can already have committed. Push success alone still does not prune the client's outbox; only a pull acknowledgement does.

After the existing duplicate and gap checks, operations stage sequentially. Expected staging failures return an error value and invalid input returns a protocol error object; cancellation discards earlier writes from that mutation. The acknowledgement shares the record transaction, rather than being saved before asynchronous reads finish.

```tsx
async function applyNextMutation(clientId, mutation) {
	// Existing caller has checked: mutation.id === lastMutationId + 1.
	const tx = openRecordAndAcknowledgementTransaction()
	for (const operation of mutation.ops) {
		// Updates await the current record and stage only the merged result.
		const result = await applyMutationOperation(tx, operation)
		if (result !== undefined) {
			await tx.cancel()
			return result
		}
	}
	stageLastMutationId(tx, clientId, mutation.id)
	return server.commitTransaction(tx)
}
```

The update branch checks the operation's payload shape and immutable identity, then uses the existing asynchronous transaction updater. Collection field validation and runtime conversion have already happened at deserialization when the caller is a wire transport. There is no validation-only codec pass in server application, and missing records remain absent:

```tsx
async function stageUpdate(tx, operation) {
	const { payload } = operation
	if (
		typeof payload !== "object" ||
		payload === null ||
		Array.isArray(payload)
	) {
		return {
			error: "invalid-request",
			message: "Update payload must be an object",
		}
	}
	if (Object.hasOwn(payload, "id")) {
		return { error: "invalid-request", message: "Identity is not editable" }
	}

	const result = await tx
		.update(operation.collection, operation.id, (current) => ({
			...current,
			...operation.payload,
		}))
		.catch((cause) => new TandemServerError({ operation: "push", cause }))
	if (result instanceof Error) return result
}
```

[[d530fc3..5556788:packages/core/test/persistence.spec.ts#L959-L1080]] exercises a reopened IndexedDB checkpoint through a real client and server. Before delivery, the client pulls a newer title and replays only its pending custom date; after delivery, the server receives the decoded `EventStart`. A later correction survives another pull, demonstrating acknowledgement pruning. The checkpoint is seeded through the storage contract because public update calls change in phase three.

[[d530fc3..5556788:packages/server/test/TandemServer.spec.ts#L667-L920]] verifies ordered mixed operations, compound identity, no resurrection, duplicate retries after a later write, rollback without acknowledgement when an update read fails, and custom identity/`Date` conversion through real JSON. [[d530fc3..5556788:packages/server/test/TandemServer.types.ts#L47-L82]] checks collection-specific identity, fields, value types, and rejection of payload identity changes. [[d530fc3..5556788:packages/core/test/persistence.spec.ts#L902-L957]] covers atomic storage rejection for both set-value and update-payload codec failures.

[[d530fc3..5556788:examples/todo/apps/web/e2e/remote.spec.ts#L45-L135]] exercises valid set/update delivery through the HTTP transport and bypasses the client encoder to send wrong field types, unknown fields, a null payload, and a set without identity. Each rejected request contains an earlier valid assignment; the final pull confirms that neither that assignment nor the mutation acknowledgement applied.

Verification passes: `pnpm test` passes all 10 tasks, including 101 core tests and 34 server tests. `pnpm build`, `pnpm type-check`, `pnpm lint`, and formatting checks pass. `pnpm --filter @tandem/example-todo-web test:e2e` passes all 8 tests. Public partial-update calls, field removal, and the full two-client concurrency matrix remain outside this phase.

### Phase 3: Expose explicit partial updates in client and server transactions

Today

Both transaction classes accept an updater returning a complete record. Client updates record that result as a set. Application examples and tests use this callback form.

Proposed

Change both public update methods to accept a collection-specific partial object excluding `id`. Preserve update-only behavior and staged reads. Record field intent directly from supplied properties, including assignments equal to the local value; do not infer intent from value equality.

Both transaction methods accept the same assignment shape. Only the server version awaits reads:

```tsx
type UpdateFields<Record> = Partial<Omit<Record, "id">> & { id?: never }

// Proposed calls; collection selects its record and ID types.
const fields: UpdateFields<EventRecord> = { title: "Planning" }
tx.update("events", "event-1", fields)
await serverTx.update("events", "event-1", fields)
```

The writer changes from recording a complete replacement to staging and recording supplied assignments:

```callstack
 Transaction.update [[packages/core/src/transaction/Transaction.ts#Transaction.update]]
-├── call the updater to obtain a full replacement
-└── append a set operation
+├── normalize explicit assignments and optional-field removals
+├── merge into the transaction-visible record if present
+└── append an update operation with the supplied field intent
 TandemServerTransaction.update [[packages/server/src/TandemServerTransaction.ts#TandemServerTransaction.update]]
-└── await the record and call the updater
+└── await the record and apply the same partial-update rules
```

The client stages the merged record directly, without calling public `set`, which would record a replacement operation as well. Copy the supplied assignments when recording the operation; do not select values later from the transaction's final record.

```diagram
┌────────────────────┐     ┌─────────────────────┐
│ Supplied fields    │────▶│ Read staged record  │
└────────────────────┘     └──────────┬──────────┘
                                     │ exists and nonempty
                                     ▼
┌────────────────────┐     ┌─────────────────────┐
│ Append update op   │◀────│ Stage merged record │
└────────────────────┘     └─────────────────────┘
```

Missing records and empty assignments return without adding an update operation:

```tsx
function update(tx, collection, id, payload) {
	validateUpdateInput(collection, payload) // Includes rejecting id changes.
	const assignments = { ...payload }
	if (Object.keys(assignments).length === 0) return tx
	const current = tx.get(collection, id)
	if (current === undefined) return tx

	stageRecord(tx, collection, { ...current, ...assignments })
	tx.ops.push({ type: "update", collection, id, payload: assignments })
	return tx
}
```

This sketch shows assignments only; the unresolved removal rule still needs its own normalization. The server transaction method uses the same merge rule but awaits its record read. Equal values are intentionally not filtered out.

```tsx
// Starting record: { id: "todo-1", title: "old", done: false }.
const tx = client.transact()
tx.update("todos", "todo-1", { done: false })
tx.update("todos", "todo-1", { title: "new" })

// Before commit, get sees both staged assignments.
expect(tx.get("todos", "todo-1")).toEqual({
	id: "todo-1",
	title: "new",
	done: false,
})
await client.commit(tx)
// Keep done: false in the first operation even if it was already false locally.
```

Migrate existing consumers and documentation in this phase if replacement of the callback API is agreed. Keep replacements explicit through `set`. Type-level coverage should reject identity changes and wrong collection fields and reflect optional fields inferred from the codec; runtime coverage should exercise ordered mixed operations and reads within one transaction.

The feature becomes usable end to end here. Validate a real client push into `TandemServer` and the resulting subscribed reads, rather than checking only the emitted operation shape.

### Phase 4: Verify concurrency and durable recovery

Today

The existing suite protects full-record outbox replay and checkpoint recovery. It does not establish field-preserving updates across concurrent clients, partial acknowledgements, and restarts.

Proposed

Extend consumer-level scenarios to distinguish field intent from a disguised full replacement. Use asymmetric fields and values so overwriting an untouched field cannot pass accidentally.

Keep existing whole-record checkpoint tests as controls, then add consumer scenarios that inspect records after controlled delivery:

```callstack
 exercise client workflows [[packages/core/test/sync/conflicts.spec.ts]]
-├── verify whole-record replacement and replay
+├── verify disjoint-field edits survive either push order
+└── verify pending updates replay over a changed confirmed base
 exercise durable recovery [[f6b65ee:packages/core/test/persistence.spec.ts#L291-L365]]
-└── restore set/remove checkpoints
+└── restore update intent without duplicating an accepted mutation
```

The concurrency scenario must expose a pull while A's update remains pending. The expected state combines B's confirmed assignments with only A's explicitly written field:

```diagram
┌───────────────────┐     ┌─────────────────────────────┐
│ B pushes title,   │────▶│ A pulls B's confirmed base │
│ priority changes  │     └──────────────┬──────────────┘
└───────────────────┘                    ▼
                           ┌─────────────────────────────┐
                           │ Replay A's pending done     │
                           └──────────────┬──────────────┘
                                          ▼
                           ┌─────────────────────────────┐
                           │ Preserve all three changes  │
                           └─────────────────────────────┘
```

The fixture operations below are pseudocode for controlled delivery, not existing harness methods. Commit locally and flush storage without starting an in-flight push; explicitly deliver pushes and pulls to expose the pending-replay state.

```tsx
type Todo = { id: string; title: string; done: boolean; priority: number }
const initial: Todo = { id: "todo-1", title: "old", done: false, priority: 3 }
const { A, B, sync } = await controlledSyncFixture(initial)
await sync.subscribeBothToTodos()

await sync.commitOffline(A, { id: "todo-1", payload: { done: true } })
await sync.commitOffline(B, {
	id: "todo-1",
	payload: { title: "new", priority: 9 },
})
await sync.deliverPush(B)
await sync.deliverPull(A) // Ack excludes A's pending mutation.

const merged = { id: "todo-1", title: "new", done: true, priority: 9 }
expect(A.get("todos", "todo-1")).toEqual(merged)

await sync.deliverPush(A)
await sync.deliverPull(A)
await sync.deliverPull(B)
expect(A.get("todos", "todo-1")).toEqual(merged)
expect(B.get("todos", "todo-1")).toEqual(merged)
// A companion scenario reverses the server application order.
```

Use separate pull and push steps or a gated remote before an in-flight push starts: Tandem serializes sync work, so holding a running push also prevents that client from pulling. A test must actually exercise replay over a changed base, not wait behind the push it blocks.

Cover same-field server ordering, explicit same-value intent, nested-field replacement, optional-field removal, deletion before replay, and ordered set/update/remove combinations through observable records. Same-value intent needs a differing remote value: assigning local `done: false` must still overwrite a server `done: true` when applied later.

For recovery, restart after a durable local commit but before delivery, then after server acceptance but before the pull acknowledgement. Confirm the original mutation ID is reused, duplicate delivery does not reapply assignments over newer server changes, and unrelated fields survive. Verify partial acknowledgement leaves later field updates replayable, and a failed server read cannot advance acknowledgement or commit a mutation prefix.

Use a separate fixture for recovery. Make duplicate delivery observable by changing the same field after the first acceptance. Otherwise, accidentally applying an assignment twice would produce the same result and the test would miss broken duplicate suppression.

```tsx
const { A, B, server, sync } = await controlledSyncFixture({
	id: "todo-1",
	title: "old",
	done: false,
	priority: 3,
})
await sync.subscribeBothToTodos()
await sync.commitOffline(A, { id: "todo-1", payload: { done: true } })
const acceptedRequest = await sync.deliverPushAndLoseResponse(A)
await sync.commitOffline(B, {
	id: "todo-1",
	payload: { done: false, title: "later edit" },
})
await sync.deliverPush(B)

const reopenedA = await sync.restartFromSavedStorage(A)
await server.push(acceptedRequest) // Force a duplicate of A's accepted mutation.
await sync.reconnectAndSettle(reopenedA)

expect(reopenedA.get("todos", "todo-1")).toEqual({
	id: "todo-1",
	title: "later edit",
	done: false,
	priority: 3,
})
// If the duplicate were reapplied, done would incorrectly become true.
```

Existing checkpoint durability and codec-failure tests remain controls. Run targeted core/server tests followed by repository type checks, tests, lint, and formatting checks. Record results here only after implementation; the draft is not evidence that the feature works.

## References

### Tandem ownership

- [[packages/core/src/transaction/Transaction.ts]]: current transaction API, operation types, and record targeting.
- [[f6b65ee:packages/core/src/utils/Codec.ts#L16-L152]] and [[f6b65ee:packages/core/src/schema/Schema.ts#L240-L277]]: implemented partial-object codec and collection inference.
- [[packages/core/src/Database.ts]]: atomic mutation bookkeeping, sparse bases, and pull replay.
- [[packages/core/src/sync/SyncEngine.ts]]: durable push barrier, serialized sync, and reconnect ordering.
- [[packages/core/src/clientStorage/TandemClientStorage.ts]] and [[packages/core/src/clientStorage/TandemClientIndexedDbStorage.ts]]: durable tuple contract and shared record/update codec boundary.
- [[packages/server/src/TandemServer.ts]] and [[packages/server/src/TandemServerTransaction.ts]]: server mutation ordering, atomic acknowledgement, and transaction reads.
- [Client storage tuples](client-storage-tuples.md): background on the current durable checkpoint design.

### Reference sync-engine source code

- [Triplit](https://github.com/aspen-cloud/triplit): transaction update semantics and field intent. Start with `packages/db/src/db-transaction.ts` and `durable-write-buffer.ts`, then the client sync engine and server sync connection. Its current partial-object/proxy update APIs do not require returned-record diffing. Its coalesced writes and push acknowledgements differ from Tandem's ordered outbox and pull acknowledgements; do not copy those semantics implicitly.
- [Replicache source](https://github.com/rocicorp/mono/tree/main/packages/replicache): optimistic transactions, mutation identity, confirmed bases, and rebase. The `rocicorp/replicache` repository is not the implementation source.
- [Zero source](https://github.com/rocicorp/mono): start with `packages/zero-client`, `packages/zero-cache`, and `packages/zql` for client writes, server processing, and query updates.
- [ElectricSQL](https://github.com/electric-sql/electric): current Postgres-to-client shape sync. Read it as a reference for read replication, not as Tandem's bidirectional mutation protocol. [electric-old](https://github.com/electric-sql/electric-old) contains the earlier bidirectional implementation.
