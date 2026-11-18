# Phase 3: Shrink core's boundary checks

**Today**

The boundary checks treat `src/browser/` and `src/node/` as exceptions. [[.oxlintrc.json]] excludes both folders from the shared-code rules, adds an override for `src/browser/`, bans imports of `**/browser/**` and `**/node/**`, and tells developers to put runtime-specific code "in src/browser or src/node behind a subpath export". `check:globals` in [[packages/core/package.json]] skips both folders. [[packages/core/AGENTS.md]] describes three groups, each with its own tsconfig. The [isomorphic tandem-core spec](../tandem-core-environment-layout/README.md) still names `/idb` and `/node` as current layout.

**Proposed**

After phases 1 and 2 the folders are gone, so every exception goes too. One rule set covers all of `src/` except [[packages/core/src/platform.ts]], specs, and type tests. The guidance says where environment code goes now: into a sibling package, or into the app.

The shared-code rules lose their folder exclusions and their folder import ban, and the `src/browser/` override goes away:

```callstack [oxlint packages/core/src]
 shared-code rules [[.oxlintrc.json]]
-├── exclude packages/core/src/browser/** and packages/core/src/node/**
 ├── exclude platform.ts, *.spec.ts, *.types.ts
 ├── no-restricted-globals # window, document, indexedDB, process, ...
 ├── no-restricted-imports
-│   ├── idb, react, react-native # "Put it in src/browser or src/node behind a subpath export."
+│   ├── idb, react, react-native # "Runtime-specific dependency. Put it in its own package."
-│   └── **/browser/**, **/node/** # "Shared core must not import environment folders."
 └── import/no-nodejs-modules
-src/browser override # import/no-nodejs-modules
```

`check:globals` drops its folder exclusions:

```sh
! grep -rn globalThis src --include='*.ts' \
	--exclude='*.spec.ts' --exclude='*.types.ts' --exclude=platform.ts \
	|| (echo 'Read runtime globals only in src/platform.ts.' >&2; exit 1)
```

Core's `build`, `type-check`, and `lint` scripts each run one `tsc` over `src/`, plus the test tsconfig in `type-check`:

```callstack [pnpm --filter @tanishqkancharla/tandem-core lint]
 oxlint src --fix
 pnpm run check:globals
 tsc --noEmit # all of src [[packages/core/tsconfig.json]]
```

The guidance in [[packages/core/AGENTS.md]] goes from three groups to one rule:

```md
Core's main entry must run unchanged in browsers, web workers, Node, Bun, Deno, Cloudflare Workers, and React Native.

- `src/` may use ECMAScript and the globals declared in `src/globals.d.ts`, nothing else. `tsconfig.json` checks it with no DOM or Node types.
- Read runtime globals only in `src/platform.ts`, and only to detect features.
- Code that needs one environment goes in its own package, such as `@tanishqkancharla/tandem-idb`, or takes its driver from the caller.
```

The earlier spec gets a short note at the top of its cover and of its phase 8 page. The note says this spec replaced the `/idb` and `/node` subpaths, and it links here. The earlier spec's phases stay as they are, since they record what was built.

No public API changes in this phase.
