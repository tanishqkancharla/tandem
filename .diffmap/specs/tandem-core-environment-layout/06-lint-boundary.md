# ✅ Phase 6: Lint rules for the boundary

[Phase 4](04-environment-folders.md) made `tsc` reject browser and Node globals in shared code, and [Phase 5](05-platform-module.md) gathered every runtime probe into `src/platform.ts`. Types cannot catch everything, though: shared code could still import `idb` or `node:fs` if a dependency's types allowed it. This phase adds lint rules with messages that say where the code belongs.

**Today**

`.oxlintrc.json` has no rules about environments.

**Proposed**

A contributor who writes browser or Node code in shared core gets a lint error naming the fix. These came from a probe file in `src/utils/`:

```text
error import(no-nodejs-modules): Do not import Node.js builtin module `node:fs`
error eslint(no-restricted-imports): 'idb' import is restricted from being used by a pattern.
  help: Runtime-specific dependency. Put it in src/browser or src/node behind a subpath export.
error eslint(no-restricted-imports): '../node/JsonlLoggerSink.js' import is restricted from being used by a pattern.
  help: Shared core must not import environment folders.
error eslint(no-restricted-globals): Unexpected use of 'localStorage'.
```

The override in [[6039942:.oxlintrc.json#L25-L76]] covers shared core and turns on the `import` plugin there only. A second override, [[6039942:.oxlintrc.json#L77-L84]], bans Node built-ins in `src/browser/`. The rules work the same whether oxlint runs from the repo root or from `packages/core`:

```jsonc [.oxlintrc.json override]
{
	"files": ["packages/core/src/**/*.ts"],
	"excludeFiles": [
		"packages/core/src/browser/**",
		"packages/core/src/node/**",
		"packages/core/src/platform.ts",
		"**/*.spec.ts",
		"**/*.types.ts"
	],
	"plugins": ["eslint", "typescript", "unicorn", "oxc", "import"],
	"rules": {
		"eslint/no-restricted-globals": ["error", "window", "self", "document", "navigator", "location",
			"localStorage", "sessionStorage", "indexedDB", "IDBKeyRange", "requestAnimationFrame",
			"ResizeObserver", "IntersectionObserver", "MutationObserver", "BroadcastChannel",
			"EventSource", "process", "Buffer", "__dirname", "__filename", "require"],
		"eslint/no-restricted-imports": ["error", { "patterns": [
			{ "group": ["idb", "react", "react-native"], "message": "Runtime-specific dependency. ..." },
			{ "group": ["**/browser/**", "**/node/**"], "message": "Shared core must not import environment folders." }
		]}],
		"import/no-nodejs-modules": "error"
	}
}
```

`no-restricted-globals` does not see `(globalThis as X).document`, which is how feature detection reads globals. A `check:globals` script in core, [[6039942:packages/core/package.json#L50]], fails on `globalThis` in shared code outside `platform.ts`, and `lint` runs it:

```callstack [pnpm lint in packages/core]
 oxlint(src, --fix)
+check:globals() # grep for globalThis outside platform.ts, src/browser, src/node, specs, and type tests
 tsc(--noEmit)
 tsc(tsconfig.browser.json, --noEmit)
 tsc(tsconfig.node.json, --noEmit)
```

It prints the offending line and `Read runtime globals only in src/platform.ts.` It uses `grep` rather than `rg`, so CI needs nothing extra.

```changes
6039942
.oxlintrc.json
packages/core/package.json

ignore:
packages/core/AGENTS.md
```
