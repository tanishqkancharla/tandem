# Phase 2: Rename `/indexeddb` to `/idb`

[PR #108](https://github.com/tanishqkancharla/tandem/pull/108) exported IndexedDB storage at `@tanishqkancharla/tandem-core/indexeddb`. This phase shortens the name before more code and docs depend on it.

**Today**

Apps import the storage from the long path:

```ts
import { TandemClientIndexedDbStorage } from "@tanishqkancharla/tandem-core/indexeddb"
```

[[packages/core/package.json#L19-L22]] defines the subpath. The test aliases in [[vitest.config.js#L17-L20]] and [[packages/core/tsconfig.test.json#L14-L16]] use the same name, and so do the docs.

**Proposed**

Apps import from `/idb`. The name is short and matches the abbreviation for the web API. The class keeps its name.

```ts
import { TandemClientIndexedDbStorage } from "@tanishqkancharla/tandem-core/idb"
```

Only the subpath key changes; the target file stays put:

```callstack [Resolving a tandem-core subpath]
-file = resolve("@tanishqkancharla/tandem-core/indexeddb") # dist/clientStorage/TandemClientIndexedDbStorage.js
+file = resolve("@tanishqkancharla/tandem-core/idb") # dist/clientStorage/TandemClientIndexedDbStorage.js
 file = resolve("@tanishqkancharla/tandem-core/node") # dist/utils/Logger.node.js
```

This breaks the import path from #108. No released version or example app uses it. The rename touches the package exports, both test aliases, two test files, the core README, `docs/client.md`, `docs/quickstart.md`, and `website/public/setup.md`.

```changes

```
