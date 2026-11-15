# Library API

[Target architecture](02-target-architecture.md) described four deployment modes. This page shows the interfaces that let one server, one client, and one sync engine run in all of them. Every name here is planned unless it links to source.

## Two seams

The flexibility comes from two small interfaces, one on each side of the sync engine:

- **`TandemPublisher`**, on the server side: "these channels changed". The in-process sync engine, an HTTP client for Tandem's sync engine service, Ably, Pusher, and a change feed all fit behind it.
- **`TandemLiveTransport`**, on the client side: "open a connection, join these channels, call `poke`". SSE, WebSocket, Ably, Pusher, and Rivet events all fit behind it.

```mermaid [The seams]
flowchart LR
    subgraph Server side
      S[TandemServer] -->|publish| P{{TandemPublisher}}
      CF[Change source] -->|publish| P
    end
    P --> E1[TandemSyncEngine in process]
    P --> E2[HTTP to sync engine service]
    P --> E3[Ably / Pusher REST]
    subgraph Client side
      L{{TandemLiveTransport}} --> R[createTandemRemote]
      R --> T[TandemClient]
    end
    E1 -.->|SSE / WebSocket| L
    E2 -.->|SSE| L
    E3 -.->|SDK| L
    %% ref node:S [[packages/server/src/TandemServer.ts#TandemServer]]
    %% ref node:T [[packages/core/src/TandemClient.ts#TandemClient]]
```

## Server side

The server gains three optional arguments. Without them it behaves as a server with no sync engine.

```ts
export type TandemServerArgs<Schema, Relations, Mutators, RequestContext> = {
	schema: RuntimeSchemaDefinition<Schema>
	relations: Relations
	storage: TandemServerStorageApi<Schema>
	mutators?: Mutators
	hooks?: (request: RequestContext | undefined) => ServerMutatorHooks<Schema, Relations, Mutators>
	/** Where commits are announced. Omit for no live updates. */
	publisher?: TandemPublisher<Schema>
	/** How records and pulls map to channels. Defaults to one channel per collection. */
	channels?: TandemChannels<Schema, RequestContext>
	/** Where pulls store each client's view. Defaults to none: every pull is a reset. */
	views?: TandemViewStore
	/** Signs the live grant in pull responses, for sync engines outside this process. */
	live?: TandemGrantSigner
}
// [!note publisher] Phase 4 adds it; until then, today's in-process poke code stays.
// [!note views] Phase 6. A long-lived process passes a memory store to keep today's small pulls.
// [!note live] Phase 7 (a shared secret) and Phase 8 (Ably and Pusher tokens).
```

A publish names channels, the commit's revision, and optionally a payload for clients that can take records:

```ts
export type TandemCommitEvent<Schema extends AnySchema> = {
	channels: string[]
	/** Missing for change-feed events, which have no Tandem revision. */
	revision?: Revision
	/** Live appends or records. Publishers may drop it and send a bare poke. */
	payload?: PokePayload<Schema>
}

export interface TandemPublisher<Schema extends AnySchema> {
	/** Called after the commit is durable. Failures are logged, never undo the commit. */
	publish(event: TandemCommitEvent<Schema>): Promise<void>
}
```

Channels default to collection names, which reproduces today's rule that a client hears about commits to collections its window reads. An app with tenants adds a key:

```ts
export type TandemChannels<Schema extends AnySchema, RequestContext> = {
	/** Channels a written or removed record belongs to. */
	record?: (record: ScanWindowRecord<Schema>) => string[]
	/** Channels a pull's window reads. Also the channels the client may join. */
	pull?: (args: { scanWindow: ScanWindow<Schema>; context?: RequestContext }) => string[]
}

const channels: TandemChannels<AppSchema, Session> = {
	record: ({ collection, value }) => [`${collection}:${value.workspaceId}`],
	pull: ({ context }) => ["todos", "lists"].map((c) => `${c}:${context!.workspaceId}`),
}
// [!note record] A removed record has only its key, so the server reads its last value before removing it.
```

The pull response gains a `live` grant: the channels, and a token the sync engine checks.

```ts
export type PullResponse<Schema extends AnySchema> = {
	cookie: Cookie
	patch: Patch<Schema>
	lastMutationId: MutationId
	revision?: Revision
	live?: TandemLiveGrant
}

export type TandemLiveGrant = {
	channels: string[]
	/** Signed by the server; opaque to the client. */
	token?: string
	/** Where to connect, when the sync engine is not same-origin. */
	url?: string
}
```

## Sync engine

`TandemSyncEngine` is the in-memory core every Tandem-run sync engine shares. It implements `TandemPublisher`, so mode 1 passes it straight to the server:

```ts
export class TandemSyncEngine<Schema extends AnySchema> implements TandemPublisher<Schema> {
	constructor(args: {
		/** Checks a grant's token. Omit when the engine runs in the server's process. */
		verify?: (token: string, clientId: ClientId) => Promise<string[] | Error>
		/** Milliseconds during which a connection's live payloads merge. @default 50 */
		livePokeInterval?: number | TimerApi
	})
	publish(event: TandemCommitEvent<Schema>): Promise<void>
	connect(args: { clientId: ClientId; poke: ClientApi<Schema>["poke"] }): TandemSyncConnection
}

export type TandemSyncConnection = {
	setChannels(grant: TandemLiveGrant): Promise<void | Error>
	close(): void
}
```

[[packages/server/src/TandemEventStream.ts#createTandemEventStreamResponse]] then takes a `TandemSyncConnection` source instead of a `RemoteApi`. A WebSocket response gets the same treatment, which Durable Objects need for hibernation ([Phase 10](15-first-class-adapters.md)).

A change feed is a publisher source:

```ts
export interface TandemChangeSource<Schema extends AnySchema> {
	/** Starts reading and calls publish for each change. Returns a stop function. */
	start(publisher: TandemPublisher<Schema>): Promise<() => Promise<void>>
}
```

## Client side

The client keeps `RemoteApi` ([[packages/core/src/sync/SyncEngine.ts#RemoteApi]]) as its internal contract. Apps stop hand-writing remotes and compose one from a request transport and a live transport:

```ts
export type TandemLiveTransport<Schema extends AnySchema> = {
	open(args: {
		clientId: ClientId
		/** Called on ready and on every poke. */
		poke: ClientApi<Schema>["poke"]
	}): Promise<TandemLiveConnection | RemoteRequestError>
}

export type TandemLiveConnection = {
	setChannels(grant: TandemLiveGrant): Promise<void>
	close(): Promise<void>
}

const remote = createTandemRemote({
	schema,
	url: "/api/tandem", // push and pull
	live: tandemEventSource({ url: "/api/tandem/events" }),
	// or: ablyLive({ client: ablyRealtime }), pusherLive({ client: pusher }), rivetLive({ actor })
})
```

`createTandemRemote` implements `RemoteApi`. `connect` opens the live transport. `pull` forwards the response's `live` grant to the open connection when it changes. A successful `push` pulls at once, which [Phase 3](08-client-side-poke-rules.md) moves into the client so no sync engine has to poke the pusher.

```callstack [createTandemRemote.pull]
+response = remote.pull({ clientId, cookie, scanWindow })
+├── response = POST url { action: "pull", args } # with MutationApi and PokeApi codecs
+├── if response.live differs from the last grant:
+│   └── connection.setChannels(response.live) # join and leave channels
+└── return response
```

## Packages

| Package or entry | Contents | Runs in |
| --- | --- | --- |
| `@tanishqkancharla/tandem-core` | `createTandemRemote`, `TandemLiveTransport`, `tandemEventSource` | Any runtime, after #112 |
| `@tanishqkancharla/tandem-server` | `TandemServer`, `TandemPublisher`, `TandemChannels`, view stores | Any runtime |
| `@tanishqkancharla/tandem-server/sql` | SQL storage and metadata migrations | Any runtime |
| `@tanishqkancharla/tandem-sync` (new) | `TandemSyncEngine`, event stream and WebSocket responses, `tandemSyncEngineClient` publisher | Any runtime |
| `@tanishqkancharla/tandem-sync/node` | Standalone sync engine HTTP server | Node |
| `@tanishqkancharla/tandem-sync/postgres` | Postgres change source | Node |
| `.../ably`, `.../pusher` | Publishers (server) and live transports (client) | Any runtime |
| `.../cloudflare`, `.../next`, `.../rivet` | Adapters from [Phase 10](15-first-class-adapters.md) | Their hosts |

A separate `tandem-sync` package keeps the sync engine free of storage code, since it deploys apart from the server. The hosted-service adapters can start as subpaths and move to their own packages if their SDKs weigh on installs; they would be optional peer dependencies.
