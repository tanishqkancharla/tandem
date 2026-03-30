# Gatekeeper

Gatekeeper is a test harness for async service-to-service flows.

You register services in order. Later services receive proxy-wrapped versions of earlier services. When a proxied downstream call is reached, Gatekeeper pauses the invocation and returns control to the test.

## Basic usage

```ts
import { Gatekeeper } from "@tandem/gatekeeper"

class Server {
	addOne(value: number): Promise<number> {
		return Promise.resolve(value + 1)
	}
}

class Client {
	constructor(private readonly server: Server) {}

	async addOneThroughServer(value: number): Promise<number> {
		return await this.server.addOne(value)
	}
}

const harness = new Gatekeeper()
	.add("server", () => new Server())
	.add("client", ({ server }: { server: Server }) => new Client(server))
	.build()

const handle = await harness.client.addOneThroughServer(1)

handle.expectRequest({ to: "server", method: "addOne", args: [1] })

const done = await handle.allowRequest({
	to: "server",
	method: "addOne",
	args: [1],
})

done.unwrapValue() // 2
```

## Handle states

Awaiting a harness method returns a `Handle`.

- If the invocation finishes without touching another service, the handle is resolved.
- If the invocation blocks on a proxied downstream call, the handle is blocked.

Both states expose `resolved` and `unwrapValue()`.

- On a resolved handle, `unwrapValue()` returns the final value.
- On a blocked handle, `unwrapValue()` throws.

## Request assertions

Blocked handles use request matchers instead of exposing request metadata directly.

```ts
type RequestMatcher = {
	to: string | "*"
	method: string | "*"
	args: unknown[] | "*"
}
```

All matcher fields are required.

- `expectRequest(matcher)` checks the blocked request and leaves the invocation blocked.
- `allowRequest(matcher)` checks the blocked request and only resumes the invocation when it matches.
- `mockReturnValue(value)` resolves the blocked call without calling the real implementation.
- `fail(error)` rejects the blocked call.

Use `"*"` when you do not care about one field.

```ts
handle.expectRequest({ to: "*", method: "addOne", args: [1] })
handle.expectRequest({ to: "server", method: "*", args: [1] })
handle.expectRequest({ to: "server", method: "addOne", args: "*" })
```

If a matcher does not match, Gatekeeper throws and leaves the invocation blocked.

## Serial flows

If one invocation makes multiple downstream calls in sequence, each successful gate action returns the next `Handle`.

```ts
const first = await harness.client.doTwoCalls(1)
first.expectRequest({ to: "server", method: "stepOne", args: [1] })

const second = await first.allowRequest({
	to: "server",
	method: "stepOne",
	args: [1],
})

second.expectRequest({ to: "server", method: "stepTwo", args: [2] })
```

## Current limits

- Services must expose async methods.
- Services must be registered in dependency order.
- Gatekeeper currently supports serial downstream blocking within one invocation.
- Concurrent blocked fan-out in one invocation is rejected.

This document is intentionally minimal. Extend it once the API settles further.
