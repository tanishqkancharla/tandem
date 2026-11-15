# Phase 4: Environment folders and tsconfigs

[Phase 1](01-core-without-dom.md) took DOM types away from core, except for the IndexedDB file. This phase does the same for Node types, and gives every environment-specific file a folder whose tsconfig names the globals it may use.

**Today**

Core's main tsconfig still loads `@types/node` for every file, so `localStorage`, `navigator`, `BroadcastChannel`, and `process` type-check in shared code. The IndexedDB storage sits in `src/clientStorage/` next to the shared storage interface. The Node logger, [[packages/core/src/utils/Logger.node.ts#JsonlLoggerSink]], sits in `src/utils/`.

**Proposed**

Public imports do not change. Inside the package, each environment-specific file moves to a folder named for the globals it needs, and each folder has a tsconfig:

```text
packages/core/
  tsconfig.json          lib ESNext, ESNext.Disposable; types []; src/ except browser/ and node/
  tsconfig.browser.json  adds DOM; src/browser/**   (replaces tsconfig.indexeddb.json)
  tsconfig.node.json     adds types ["node"]; src/node/**
  tsconfig.test.json     DOM and Node, for tests
  src/
    globals.d.ts                              globals every target runtime has
    browser/TandemClientIndexedDbStorage.ts   -> "./idb"
    node/JsonlLoggerSink.ts                   -> "./node"
```

Subpaths name what an entry holds, not where it runs. IndexedDB exists in browsers, web workers, and Deno, so a `/browser` entry would mislabel it. Folders group by type set instead, because that is what a tsconfig can check.

Without `@types/node`, the shared group declares the globals it uses. Every target runtime provides them, and they already appear in `Timer.ts`, `TabHub.ts`, `TabSession.ts`, `TabEnvironment.ts`, `Stream.ts`, `Logger.ts`, and `TandemEventSource.ts`:

```ts [src/globals.d.ts]
declare function setTimeout(callback: () => void, ms?: number): unknown
declare function clearTimeout(id: unknown): void
declare function setInterval(callback: () => void, ms?: number): unknown
declare function clearInterval(id: unknown): void
declare function queueMicrotask(callback: () => void): void
declare function structuredClone<T>(value: T): T
declare const console: Record<"debug" | "info" | "warn" | "log" | "error", (...data: unknown[]) => void>
declare class AbortSignal {
	readonly aborted: boolean
	addEventListener(type: "abort", listener: () => void, options?: { once?: boolean }): void
	removeEventListener(type: "abort", listener: () => void): void
}
declare class MessageChannel {
	readonly port1: MessagePortLike
	readonly port2: MessagePortLike
}
interface MessagePortLike {
	addEventListener(type: "message", listener: () => void): void
	postMessage(message: unknown): void
	start(): void
	close(): void
}
// [!note AbortSignal] Emitted declarations keep the global name, so consumers see their own runtime's type.
```

The build compiles each group with its own globals:

```callstack [pnpm build in packages/core]
 dist = tsc() # shared group, globals.d.ts only
-dist/clientStorage/TandemClientIndexedDbStorage.js = tsc(tsconfig.indexeddb.json)
+dist/browser/TandemClientIndexedDbStorage.js = tsc(tsconfig.browser.json) # adds DOM
+dist/node/JsonlLoggerSink.js = tsc(tsconfig.node.json) # adds @types/node
```

The environment projects import shared modules and re-emit identical `dist/` files, so the cost is build time. `tsc -b` with project references would avoid this; adopt it if TypeScript 7's native compiler supports build mode for this repo.

The export targets follow the moved files:

```callstack [Resolving a tandem-core subpath]
-file = resolve("@tanishqkancharla/tandem-core/idb") # dist/clientStorage/TandemClientIndexedDbStorage.js
+file = resolve("@tanishqkancharla/tandem-core/idb") # dist/browser/TandemClientIndexedDbStorage.js
-file = resolve("@tanishqkancharla/tandem-core/node") # dist/utils/Logger.node.js
+file = resolve("@tanishqkancharla/tandem-core/node") # dist/node/JsonlLoggerSink.js
```

```changes

```
