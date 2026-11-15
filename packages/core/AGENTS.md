# tandem-core environments

Core's main entry must run unchanged in browsers, web workers, Node, Bun, Deno, Cloudflare Workers, and React Native.

- Shared code is everything in `src/` outside `src/browser/` and `src/node/`. It may use ECMAScript and the globals declared in `src/globals.d.ts`, nothing else. `tsconfig.json` checks it with no DOM or Node types.
- `src/browser/` may use DOM APIs; `tsconfig.browser.json` checks it. `src/node/` may use Node APIs; `tsconfig.node.json` checks it.
- Each environment file ships behind its own subpath in `package.json`, named for what it holds (`./idb`, `./node`), never re-exported from the main entry. Shared code must not import from these folders.
- New storage backends take their engine as an argument where they can, so they stay in shared code. Every client storage runs the contract in `test/clientStorageContract.ts`.
- Tests get no IndexedDB by default. `test/idb-storage.spec.ts` installs `fake-indexeddb` for its own file only.
