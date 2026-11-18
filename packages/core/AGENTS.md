# tandem-core environments

Core's main entry must run unchanged in browsers, web workers, Node, Bun, Deno, Cloudflare Workers, and React Native.

- Shared code is everything in `src/` outside `src/browser/` and `src/node/`. It may use ECMAScript and the globals declared in `src/globals.d.ts`, nothing else. `tsconfig.json` checks it with no DOM or Node types.
- `src/browser/` may use DOM APIs; `tsconfig.browser.json` checks it. `src/node/` may use Node APIs; `tsconfig.node.json` checks it.
- Each environment file ships behind its own subpath in `package.json`, named for what it holds (`./idb`, `./node`), never re-exported from the main entry. Shared code must not import from these folders.
- Shared code that picks a default from the runtime, such as tab coordination or the global `EventSource`, reads globals only through `src/platform.ts`.
- New storage backends take their engine as an argument where they can, so they stay in shared code. Every client storage runs the contract in `test/clientStorageContract.ts`.
- oxlint rules in the root `.oxlintrc.json` and `pnpm run check:globals` enforce these rules; `pnpm run lint` runs both.
- `test/runtime.spec.ts` bundles the main entry and runs it in plain Node and in workerd with no polyfills.
- Tests get no IndexedDB by default. `test/idb-storage.spec.ts` installs `fake-indexeddb` for its own file only.
