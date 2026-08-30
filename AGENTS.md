# Agent Instructions

Tandem is unreleased. Do not preserve migrations, compatibility fallbacks, or legacy code paths unless the user explicitly asks for them. Prefer cutting and editing relentlessly before release: keep the design small, remove obsolete behavior, and avoid compatibility layers that only serve pre-release states.

Tests should protect user-facing behavior and developer experience, not internal data formats. Prefer type-level tests for TypeScript inference APIs, public API boundary tests for runtime behavior, and fail-fast tests only for errors developers can actually encounter. Avoid snapshotting or asserting exact internal normalized/encoded structures unless that structure is a documented public contract.

## Cursor Cloud specific instructions

Tandem is a pnpm (`pnpm@10.12.4`) + Turborepo monorepo of three publishable **libraries** (`@get-halo/tandem-core`, `@get-halo/tandem-server`, `@get-halo/tandem-types`) — there is no long-running app, server binary, or dev server to start. "Running" the project means building and exercising it through its test suites. Standard commands live in the root `package.json` and delegate to Turbo: `pnpm build`, `pnpm lint`, `pnpm type-check`, `pnpm format`, `pnpm test`.

- The default `pnpm test` runs fully in-process: `@get-halo/tandem-core` uses `fake-indexeddb`, and `@get-halo/tandem-server` adapter tests run the `memory`, `json-file`, and `sqlite` (`better-sqlite3`) providers.
- Postgres/MySQL adapter tests are optional and gated behind `TANDEM_DOCKER_TESTS=1` (run via `pnpm --filter @get-halo/tandem-server test:docker`, which uses `packages/server/docker-compose.test.yml`). Docker is **not** installed in the base cloud environment, so these providers are skipped by default; install Docker first if you need them.
- Sync gotcha when writing demos/tests: the sync engine only propagates data for scan windows a client is subscribed to. A client must `subscribe(...)` (or call `pullFromRemote()`) before committed records from another client sharing the same remote will appear locally.
