# ✅ Phase 5: Feature detection in one module

[Phase 4](04-environment-folders.md) left shared code without DOM or Node types. Three shared modules still read environment globals at runtime, through `globalThis`, to pick their defaults. This phase gathers those reads into one module, so [Phase 6](06-lint-boundary.md) can allow them there and ban them everywhere else.

**Today**

Each module probes the environment in its own way: `browserTabEnvironment` in `src/tabs/TabEnvironment.ts` checks `document`, `navigator.locks`, and `BroadcastChannel`; `VisibilityAwareTimer` reads `document.visibilityState`; `connectTandemEventSource` defaults to `globalThis.EventSource`.

**Proposed**

Apps see the same defaults: tabs share a replica in a browser document, the leader's timer speeds up while hidden, and the event stream uses the global `EventSource`. Each turns off where its API is missing, as before. Only [[2d1adc5:packages/core/src/platform.ts#L1-L49]] reads `globalThis`:

```ts [src/platform.ts]
type PlatformGlobals = {
	document?: VisibilityDocument
	navigator?: { locks?: TabLocksApi }
	BroadcastChannel?: new (name: string) => TabChannelApi
	EventSource?: TandemEventSourceConstructor<unknown>
}

const platform = globalThis as PlatformGlobals

export function browserTabEnvironment(): TabEnvironmentApi | undefined {
	const locks = platform.navigator?.locks
	const Channel = platform.BroadcastChannel
	if (!platform.document || !locks || !Channel) return undefined
	return {
		locks: { request: (name, callback) => locks.request(name, callback) },
		openChannel: (name) => new Channel(name),
	}
}

export function visibilityDocument(): VisibilityDocument | undefined {
	return platform.document
}

export function globalEventSource<Init>(): TandemEventSourceConstructor<Init> | undefined {
	return platform.EventSource as TandemEventSourceConstructor<Init> | undefined
}
// [!note PlatformGlobals] Structural types only, so this file stays in shared code without DOM.
```

The callers stop touching `globalThis`:

```callstack [Choosing platform defaults]
 tabs = resolveTabs(tabs, clientStorage, remote) [[2d1adc5:packages/core/src/TandemClient.ts#L125-L138]]
 └── environment = browserTabEnvironment() # moved to src/platform.ts [[2d1adc5:packages/core/src/platform.ts#L30-L38]]
 tick = VisibilityAwareTimer.waitForNextTick() [[2d1adc5:packages/core/src/utils/Timer.ts#L46-L62]]
-└── document = globalThis.document
+└── document = visibilityDocument() [[2d1adc5:packages/core/src/utils/Timer.ts#L47]]
 unsubscribe = connectTandemEventSource(args)
-└── EventSource = args.EventSource ?? globalThis.EventSource
+└── EventSource = args.EventSource ?? globalEventSource() [[2d1adc5:packages/core/src/sync/TandemEventSource.ts#L91]]
```

`Schema.ts` wrote `globalThis.Record` for a type, though nothing shadows `Record` there. It now writes `Record`, so the only `globalThis` in shared code is in `platform.ts`.

```changes
2d1adc5
packages/core/src/platform.ts
packages/core/src/TandemClient.ts
packages/core/src/utils/Timer.ts
packages/core/src/sync/TandemEventSource.ts
packages/core/src/tabs/TabEnvironment.ts

ignore:
packages/core/AGENTS.md
packages/core/src/schema/Schema.ts
```
