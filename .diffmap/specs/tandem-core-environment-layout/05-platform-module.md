# Phase 5: Feature detection in one module

[Phase 4](04-environment-folders.md) left the shared group without DOM or Node types. Three shared modules still read environment globals at runtime, through `globalThis`, to pick their defaults. This phase gathers those reads into one module, so [Phase 6](06-lint-boundary.md) can allow them there and ban them everywhere else.

**Today**

Each module probes the environment in its own way:

- [[packages/core/src/tabs/TabEnvironment.ts#browserTabEnvironment]] checks `document`, `navigator.locks`, and `BroadcastChannel`;
- [[packages/core/src/utils/Timer.ts#VisibilityAwareTimer]] reads `document.visibilityState`;
- [[packages/core/src/sync/TandemEventSource.ts#connectTandemEventSource]] defaults to `globalThis.EventSource`.

**Proposed**

Apps see the same defaults: tabs share a replica in a browser document, the leader's timer speeds up while hidden, and the event stream uses the global `EventSource`. Each turns off where its API is missing, as now. Only `src/platform.ts` reads `globalThis`:

```ts [src/platform.ts]
type PlatformGlobals = {
	document?: VisibilityDocument
	navigator?: { locks?: TabLocksApi }
	BroadcastChannel?: new (name: string) => TabChannelApi
	EventSource?: TandemEventSourceConstructor<unknown>
}

const platform = globalThis as PlatformGlobals

/** Web Locks and BroadcastChannel in a browser document, or undefined elsewhere. */
export function browserTabEnvironment(): TabEnvironmentApi | undefined {
	const locks = platform.navigator?.locks
	const Channel = platform.BroadcastChannel
	if (!platform.document || !locks || !Channel) return undefined
	return {
		locks: { request: (name, callback) => locks.request(name, callback) },
		openChannel: (name) => new Channel(name),
	}
}

/** The page's visibility, or undefined outside a document. */
export function visibilityDocument(): VisibilityDocument | undefined {
	return platform.document
}

export function globalEventSource<Init>(): TandemEventSourceConstructor<Init> | undefined {
	return platform.EventSource as TandemEventSourceConstructor<Init> | undefined
}
// [!note PlatformGlobals] Structural types only, so this file stays in the shared group without DOM.
```

The callers stop touching `globalThis`:

```callstack [Choosing platform defaults]
 tabs = resolveTabs(tabs, clientStorage, remote) [[packages/core/src/TandemClient.ts#resolveTabs]]
-└── environment = browserTabEnvironment() [[packages/core/src/tabs/TabEnvironment.ts#browserTabEnvironment]]
+└── environment = browserTabEnvironment() # moved to src/platform.ts
 tick = VisibilityAwareTimer.waitForNextTick() [[packages/core/src/utils/Timer.ts#VisibilityAwareTimer.waitForNextTick]]
-└── document = globalThis.document
+└── document = visibilityDocument() # src/platform.ts
 unsubscribe = connectTandemEventSource(args) [[packages/core/src/sync/TandemEventSource.ts#connectTandemEventSource]]
-└── EventSource = args.EventSource ?? globalThis.EventSource
+└── EventSource = args.EventSource ?? globalEventSource() # src/platform.ts
```

```changes

```
