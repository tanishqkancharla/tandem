# Phase 8: Ably and Pusher as sync engines

[Phase 7](12-standalone-sync-engine.md) gave apps a sync engine they deploy themselves. This phase lets apps skip that service and use a hosted pub/sub service instead, which is mode 4 in [Target architecture](02-target-architecture.md#mode-4-hosted-pub-sub-ably-pusher). The [Library API](03-library-api.md#two-seams) seams carry it: a `TandemPublisher` on the server and a `TandemLiveTransport` on the client.

**Today**

An app on Vercel with an Ably or Pusher account has to hand-write a remote whose `connect` subscribes to the service, and publish from its own mutator hooks.

**Proposed**

The app passes `ablyPublisher` or `pusherPublisher` to the server and `ablyLive` or `pusherLive` to `createTandemRemote`. It runs no long-lived process of its own.

```ts
// server
const server = new TandemServer({
	// ...
	publisher: ablyPublisher({ rest: new Ably.Rest(ABLY_KEY) }),
	live: ablyGrants({ rest }), // pull responses carry an Ably token request scoped to the client's channels
})

// client
const remote = createTandemRemote({ schema, url: "/api/tandem", live: ablyLive({ realtime }) })
```

## Mapping the contract

| Tandem | Ably | Pusher |
| --- | --- | --- |
| `publish({ channels })` | `channels.get(name).publish("poke", data)` per channel | `trigger(names, "poke", data)`, up to 100 channels per call |
| Grant token | Token request with `subscribe` capability on the channels | Private channel auth, signed per channel by an app route |
| `ready` (pull now) | Connection state `connected`, and channel `attached` after a gap | Connection state `connected` |
| Channel name `todos:42` | Allowed; prefix with a namespace such as `tandem:` | Not allowed; encode to `private-tandem-todos-42` |
| Message size limit | 64 KB by default | 10 KB |

## Payloads

The publishers send bare pokes by default. Append payloads are opt-in (`payloads: "appends"`), and the publisher drops a payload larger than the service's limit and sends a bare poke instead, since the client pulls either way. Both services bill per message delivered, so an agent streaming text to many clients costs one message per throttle interval per subscriber; the docs show the arithmetic.

```callstack [ablyPublisher.publish]
+ablyPublisher.publish({ channels, payload })
+├── data = payload && options.payloads === "appends" ? encode(payload) : undefined
+├── if data is over the size limit: data = undefined
+└── for each channel: rest.channels.get(`tandem:${channel}`).publish("poke", data)
```

On the client, the transport maps service events back to `poke`:

```callstack [ablyLive.open]
+connection = ablyLive.open({ clientId, poke })
+├── realtime.connection.on("connected", () => poke()) # same as ready
+└── return { setChannels(grant): attach to new channels, detach from old, subscribe("poke", (m) => poke(decode(m.data))) }
```

Tests: a contract suite for `TandemLiveTransport` and `TandemPublisher` runs against the SSE sync engine and fakes of both services, checking ready-on-connect, channel joins and leaves, and size fallback. Live tests against real accounts run only when keys are present. `dst/` needs no new model: the service is a sync engine whose publishes can drop.

```changes

```
