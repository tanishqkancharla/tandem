# ✅ Phase 4: Environment folders and tsconfigs

[Phase 1](01-core-without-dom.md) took DOM types away from core, except for the IndexedDB file. This phase does the same for Node types, and gives every environment-specific file a folder whose tsconfig names the globals it may use.

**Today**

Core's main tsconfig still loads `@types/node` for every file, so `localStorage`, `navigator`, `BroadcastChannel`, `process`, and `Buffer` type-check in shared code. The IndexedDB storage sits in `src/clientStorage/` next to the shared storage interface, and the Node logger sits in `src/utils/Logger.node.ts`.

**Proposed**

Public imports do not change. `tsc` rejects Node and browser globals in shared code:

```text
src/utils/probe.ts(1,18): error TS2304: Cannot find name 'localStorage'.
src/utils/probe.ts(2,18): error TS2591: Cannot find name 'process'.
src/utils/probe.ts(3,18): error TS2304: Cannot find name 'navigator'.
src/utils/probe.ts(4,18): error TS2591: Cannot find name 'Buffer'.
```

Each environment-specific file moved to a folder named for the globals it needs, and each folder has a tsconfig:

```text
packages/core/
  tsconfig.json          lib ESNext, ESNext.Disposable; types []; src/ except browser/ and node/
  tsconfig.browser.json  adds DOM; src/browser/**   (was tsconfig.indexeddb.json)
  tsconfig.node.json     adds types ["node"]; src/node/**
  tsconfig.test.json     DOM and Node, for tests; leaves out src/globals.d.ts
  src/
    globals.d.ts                              globals every target runtime has
    browser/TandemClientIndexedDbStorage.ts   -> "./idb"
    node/JsonlLoggerSink.ts                   -> "./node"
```

Subpaths name what an entry holds, not where it runs. IndexedDB exists in browsers, web workers, and Deno, so a `/browser` entry would mislabel it. Folders group by type set instead, because that is what a tsconfig can check.

Without `@types/node`, shared code declares the globals it uses in [[0f17f23:packages/core/src/globals.d.ts#L1-L42]]. Every target runtime provides them. The file is an ES module, because the package's `type` is `module`, so the declarations sit in `declare global`:

```ts [src/globals.d.ts]
export {}

declare global {
	// Browsers return a number and Node a Timeout object.
	function setTimeout(callback: () => void, ms?: number): number | object
	function clearTimeout(id: number | object | undefined): void
	function setInterval(callback: () => void, ms?: number): number | object
	function clearInterval(id: number | object | undefined): void
	function queueMicrotask(callback: () => void): void
	function structuredClone<T>(value: T): T
	var console: Record<"debug" | "info" | "warn" | "log" | "error", (...data: unknown[]) => void>
	interface AbortSignal { /* aborted, addEventListener, removeEventListener */ }
	var MessageChannel: new () => { readonly port1: TandemMessagePort; readonly port2: TandemMessagePort }
}
// [!note AbortSignal] Only a type in shared code, so emitted declarations name the global and consumers see their own runtime's type.
// [!note MessageChannel] Used only inside Timer.ts, so TandemMessagePort never appears in dist.
```

The build compiles each group with its own globals:

```callstack [pnpm build in packages/core]
 dist = tsc() # shared code, globals.d.ts only
-dist/clientStorage/TandemClientIndexedDbStorage.js = tsc(tsconfig.indexeddb.json)
+dist/browser/TandemClientIndexedDbStorage.js = tsc(tsconfig.browser.json) # adds DOM [[0f17f23:packages/core/package.json#L45]]
+dist/node/JsonlLoggerSink.js = tsc(tsconfig.node.json) # adds @types/node
```

`type-check` and `lint` run all three projects. The environment projects import shared modules and re-emit identical `dist/` files, so the cost is build time.

The export targets follow the moved files:

```callstack [Resolving a tandem-core subpath]
-file = resolve("@tanishqkancharla/tandem-core/idb") # dist/clientStorage/TandemClientIndexedDbStorage.js
+file = resolve("@tanishqkancharla/tandem-core/idb") # dist/browser/TandemClientIndexedDbStorage.js [[0f17f23:packages/core/package.json#L19-L22]]
-file = resolve("@tanishqkancharla/tandem-core/node") # dist/utils/Logger.node.js
+file = resolve("@tanishqkancharla/tandem-core/node") # dist/node/JsonlLoggerSink.js [[0f17f23:packages/core/package.json#L23-L26]]
```

`packages/core/AGENTS.md` now states these rules for contributors.

```changes
0f17f23
packages/core/tsconfig.json
packages/core/src/globals.d.ts
packages/core/tsconfig.browser.json
packages/core/tsconfig.node.json
packages/core/package.json
packages/core/AGENTS.md

ignore:
packages/core/benchmarks/tabs.ts
packages/core/src/browser/TandemClientIndexedDbStorage.ts
packages/core/src/clientStorage/AGENTS.md
packages/core/src/node/JsonlLoggerSink.ts
packages/core/src/utils/Logger.spec.ts
packages/core/tsconfig.test.json
vitest.config.js
```
