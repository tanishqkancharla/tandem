# Phase 6: Lint rules for the boundary

[Phase 4](04-environment-folders.md) made `tsc` reject browser and Node globals in shared code, and [Phase 5](05-platform-module.md) gathered every runtime probe into `src/platform.ts`. Types cannot catch everything, though: shared code could still import `idb` or `node:fs` if a dependency's types allowed it. This phase adds lint rules with messages that say where the code belongs.

**Today**

[[.oxlintrc.json]] has no rules about environments.

**Proposed**

A contributor who writes browser or Node code in shared core gets a lint error naming the fix:

```text
eslint(no-restricted-globals): Unexpected use of 'localStorage'.
eslint(no-restricted-imports): 'node:fs' import is restricted from being used by a pattern.
  help: Node-only. Put it in src/node/ behind a subpath.
```

The overrides cover core's shared group. A probe file confirmed that oxlint 1.87 enforces all three rules; the `import` plugin must be added to `plugins`:

```jsonc [.oxlintrc.json override]
{
	"files": ["packages/core/src/**/*.ts"],
	"excludeFiles": [
		"packages/core/src/browser/**",
		"packages/core/src/node/**",
		"packages/core/src/platform.ts"
	],
	"rules": {
		"eslint/no-restricted-globals": ["error",
			"window", "document", "navigator", "location", "localStorage", "sessionStorage",
			"indexedDB", "IDBKeyRange", "requestAnimationFrame", "ResizeObserver",
			"IntersectionObserver", "MutationObserver", "BroadcastChannel", "EventSource",
			"process", "Buffer", "__dirname", "__filename", "require"],
		"eslint/no-restricted-imports": ["error", { "patterns": [
			{ "group": ["node:*", "fs", "path", "os", "child_process"], "message": "Node-only. Put it in src/node/ behind a subpath." },
			{ "group": ["idb", "react", "react-native"], "message": "Environment-specific dependency. Put it behind a subpath." },
			{ "group": ["**/browser/**", "**/node/**"], "message": "Shared code must not import environment folders." }
		]}],
		"import/no-nodejs-modules": "error"
	}
}
// [!note excludeFiles] Check the override syntax against the installed oxlint docs before landing.
```

A second override bans Node modules in `src/browser/**`.

`no-restricted-globals` does not see `(globalThis as X).document`, which is how feature detection reads globals. A text check in core's lint script closes that gap:

```callstack [pnpm lint in packages/core]
 oxlint(src, --fix)
+rg("globalThis\\.", src, excluding src/platform.ts) # fail on any match
 tsc(--noEmit)
+tsc(tsconfig.browser.json, --noEmit)
+tsc(tsconfig.node.json, --noEmit)
```

`globalThis.Record` in [[packages/core/src/schema/Schema.ts]] is a type and gets rewritten, so the check stays a plain text match.

```changes

```
