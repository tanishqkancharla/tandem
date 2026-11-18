# ✅ Phase 2: Rename `/indexeddb` to `/idb`

[PR #108](https://github.com/tanishqkancharla/tandem/pull/108) exported IndexedDB storage at `@tanishqkancharla/tandem-core/indexeddb`. This phase shortens the name before more code and docs depend on it.

**Today**

Apps import the storage from the long path:

```ts
import { TandemClientIndexedDbStorage } from "@tanishqkancharla/tandem-core/indexeddb"
```

**Proposed**

Apps import from `/idb`. The name is short and matches the abbreviation for the web API. The class keeps its name.

```ts
import { TandemClientIndexedDbStorage } from "@tanishqkancharla/tandem-core/idb"
```

Only the subpath key in [[60470ce:packages/core/package.json#L19-L22]] changes; the target file stays put:

```callstack [Resolving a tandem-core subpath]
-file = resolve("@tanishqkancharla/tandem-core/indexeddb") # dist/clientStorage/TandemClientIndexedDbStorage.js
+file = resolve("@tanishqkancharla/tandem-core/idb") # dist/clientStorage/TandemClientIndexedDbStorage.js [[60470ce:packages/core/package.json#L19-L22]]
 file = resolve("@tanishqkancharla/tandem-core/node") # dist/utils/Logger.node.js
```

This breaks the import path from #108. No released version or example app uses it.

```changes
60470ce
packages/core/package.json
docs/client.md
docs/quickstart.md

ignore:
packages/core/README.md
packages/core/test/fixtures.ts
packages/core/test/tabs.spec.ts
packages/core/tsconfig.test.json
vitest.config.js
website/public/setup.md
```
