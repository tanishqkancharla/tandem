# Agent Instructions

Tandem is unreleased. Do not preserve migrations, compatibility fallbacks, or legacy code paths unless the user explicitly asks for them. Prefer cutting and editing relentlessly before release: keep the design small, remove obsolete behavior, and avoid compatibility layers that only serve pre-release states.

## Naming

- Infrastructure abstractions owned by `tuple-database`, including Tandem's structural views over its APIs, use the `Tuple` domain name (`TupleX` or `AsyncTupleX`).
- Tandem-owned infrastructure abstractions use the `Tandem` domain name (`TandemX` or `AsyncTandemX`). Generic domain vocabulary such as `Schema`, `Relations`, and `Query` can remain unprefixed when its meaning is clear from the package or module.
- Boundary adapters name both sides and the conversion direction, such as `tandemStorageToTupleDatabaseStorage`.

Tests should protect user-facing behavior and developer experience, not internal data formats. Prefer type-level tests for TypeScript inference APIs, public API boundary tests for runtime behavior, and fail-fast tests only for errors developers can actually encounter. Avoid snapshotting or asserting exact internal normalized/encoded structures unless that structure is a documented public contract.

When writing tests, load the `testing` skill.

## Error handling (errore.org)

This codebase uses the [errore.org](https://errore.org) convention. Always read the `errore` skill (`.agents/skills/errore/SKILL.md`) before editing TypeScript that handles failures. Always `import * as errore from "errore"`.

- Use errors as values inside Tandem. If the failure is expected and comes from app code, return an `Error` (prefer `errore.createTaggedError`) instead of throwing. Internal callers check with `instanceof Error` and early-return.
- Do not expose errore conventions through consumer-facing APIs. Exported APIs return normal success values and throw or reject on failure; their types must not include `Error | T`, and internal tagged error classes stay unexported unless they are an intentional public contract.
- If the failure is expected and comes from external library code (or other throwing APIs such as `JSON.parse`, `fetch`, file I/O), convert at that boundary with `errore.try` (sync) or `.catch((e) => new MyError({ cause: e }))` (async). Prefer `.catch()` over `errore.tryAsync`.
- Do not catch unexpected exceptions. When one shows up, pick a strategy for that case.
- Replace `try`/`finally` resource cleanup with `await using` + `errore.AsyncDisposableStack` (or `using` + `errore.DisposableStack`) when cleanup is needed.
- At consumer or legacy boundaries that require throws, convert a returned error back to a throw only at that edge: `if (result instanceof Error) throw result`.

## Cursor Cloud specific instructions

Tandem is a pnpm (`pnpm@10.12.4`) + Turborepo monorepo of three publishable **libraries** (`@tanishqkancharla/tandem-core`, `@tanishqkancharla/tandem-server`, `@tanishqkancharla/tandem-react`) — there is no long-running app, server binary, or dev server to start. "Running" the project means building and exercising it through its test suites. Standard commands live in the root `package.json` and delegate to Turbo: `pnpm build`, `pnpm lint`, `pnpm type-check`, `pnpm format`, `pnpm test`.

- The default `pnpm test` runs fully in-process: `@tanishqkancharla/tandem-core` uses `fake-indexeddb`, and `@tanishqkancharla/tandem-server` adapter tests run the `memory`, `json-file`, and `sqlite` (`better-sqlite3`) providers.
- Postgres/MySQL adapter tests are optional and gated behind `TANDEM_DOCKER_TESTS=1` (run via `pnpm --filter @tanishqkancharla/tandem-server test:docker`, which uses `packages/server/docker-compose.test.yml`). Docker is **not** installed in the base cloud environment, so these providers are skipped by default; install Docker first if you need them.
- Sync gotcha when writing demos/tests: the sync engine only propagates data for scan windows a client is subscribed to. A client must `subscribe(...)` (or call `pullFromRemote()`) before committed records from another client sharing the same remote will appear locally.
