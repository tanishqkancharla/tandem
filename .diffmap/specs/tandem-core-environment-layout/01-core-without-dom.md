# ⏳ Phase 1: Type-check core without DOM types

[PR #108](https://github.com/tanishqkancharla/tandem/pull/108) moved IndexedDB storage behind its own subpath. This phase stops the rest of core from compiling against browser types. It is [PR #110](https://github.com/tanishqkancharla/tandem/pull/110).

**Today**

A contributor can use `window` or `document` anywhere in core and `tsc` accepts it. The root tsconfig gives core the DOM lib. A `/// <reference lib="dom" />` at the top of [[packages/core/src/clientStorage/TandemClientIndexedDbStorage.ts]] adds DOM back to the whole program, even without the lib.

**Proposed**

`tsc` rejects browser globals outside the IndexedDB storage:

```text
src/utils/domProbe.ts: error TS2304: Cannot find name 'window'.
src/utils/domProbe.ts: error TS2584: Cannot find name 'document'.
```

Core's main tsconfig drops DOM and leaves out the IndexedDB file, which builds through `tsconfig.indexeddb.json`, the only project that keeps DOM:

```callstack [pnpm build in packages/core]
-dist = tsc() # one program, DOM lib from the root tsconfig
+dist = tsc() # every file but the IndexedDB storage, lib ESNext only
+dist/clientStorage/TandemClientIndexedDbStorage.js = tsc(tsconfig.indexeddb.json) # lib ESNext + DOM
```

`type-check` and `lint` run both projects. The built files keep their places in `dist/`.

`localStorage`, `navigator`, and `BroadcastChannel` still type-check, because core loads `@types/node`. [Phase 4](04-environment-folders.md) removes that.

```changes
3fd7af1
packages/core/tsconfig.json
packages/core/tsconfig.indexeddb.json
packages/core/package.json
packages/core/src/clientStorage/TandemClientIndexedDbStorage.ts
```
