# Agent Instructions

Tandem is a sync engine and database for collaborative apps. Each client gets a local, queryable database: writes apply locally first, sync to a server in the background, and replay on top of what the server sends back.

```
packages/
  core/        @tanishqkancharla/tandem-core: client database, schema, queries, sync engine
  server/      @tanishqkancharla/tandem-server: server database and storage adapters
  react/       @tanishqkancharla/tandem-react: React provider and hooks
  gatekeeper/  @tanishqkancharla/gatekeeper: test harness that controls call order and faults
dst/           deterministic simulation tests
examples/      todo and agent-chat apps
docs/          user docs
website/       project website
tools/         dst-video: renders videos of DST failures
```

Tandem is unreleased. Do not preserve migrations, compatibility fallbacks, or legacy code paths unless the user explicitly asks for them. Prefer cutting and editing relentlessly before release: keep the design small, remove obsolete behavior, and avoid compatibility layers that only serve pre-release states.

## Goals

Both goals are still in progress. Move toward them with each change.

- Support every layer of the stack: any frontend, any application server, any database.
- Test rigorously: public API tests, deterministic simulation with faults and crashes, and end-to-end tests in the examples.

## Skills

Use the [conventions skill](.agents/skills/conventions/SKILL.md) when writing, refactoring, or reviewing TypeScript packages, services, state, dependencies, environments, or tests. Read the pages relevant to the change rather than the whole handbook. When changing tests, also read the existing [testing skill](.agents/skills/testing/SKILL.md) and any closer package-level `AGENTS.md` instructions.

## Writing

Follow George Orwell's six rules when writing prose meant for people to read, such as docs, READMEs, specs, comments, commit messages, and PR descriptions:

1. Never use a metaphor, simile, or other figure of speech which you are used to seeing in print.
2. Never use a long word where a short one will do.
3. If it is possible to cut a word out, always cut it out.
4. Never use the passive where you can use the active.
5. Never use a foreign phrase, a scientific word, or a jargon word if you can think of an everyday English equivalent.
6. Break any of these rules sooner than say anything outright barbarous.

## Naming

- Infrastructure abstractions owned by `tuple-database`, including Tandem's structural views over its APIs, use the `Tuple` domain name (`TupleX` or `AsyncTupleX`).
- Tandem-owned infrastructure abstractions use the `Tandem` domain name (`TandemX` or `AsyncTandemX`). Generic domain vocabulary such as `Schema`, `Relations`, and `Query` can remain unprefixed when its meaning is clear from the package or module.
- Boundary adapters name both sides and the conversion direction, such as `tandemStorageToTupleDatabaseStorage`.

Tests should protect user-facing behavior and developer experience, not internal data formats. Prefer type-level tests for TypeScript inference APIs, public API boundary tests for runtime behavior, and fail-fast tests only for errors developers can actually encounter. Avoid snapshotting or asserting exact internal normalized/encoded structures unless that structure is a documented public contract.

When writing tests, load the `testing` skill.

## Deterministic simulation testing

When changing Tandem behavior, ensure `dst/` can exercise the affected behavior through the public API. Extend the generator, driver, trace, and replay when adding operations. Include checks that distinguish correct behavior from mere convergence, and run relevant seed sweeps with network faults and crashes. Passing seeds that never exercise the changed behavior do not establish coverage.

## Error handling (errore.org)

This codebase uses the [errore.org](https://errore.org) convention. Always read the `errore` skill (`.agents/skills/errore/SKILL.md`) before editing TypeScript that handles failures. Always `import * as errore from "errore"`.

- Use errors as values inside Tandem. If the failure is expected and comes from app code, return an `Error` (prefer `errore.createTaggedError`) instead of throwing. Internal callers check with `instanceof Error` and early-return.
- Do not expose errore conventions through consumer-facing APIs. Exported APIs return normal success values and throw or reject on failure; their types must not include `Error | T`, and internal tagged error classes stay unexported unless they are an intentional public contract.
- If the failure is expected and comes from external library code (or other throwing APIs such as `JSON.parse`, `fetch`, file I/O), convert at that boundary with `errore.try` (sync) or `.catch((e) => new MyError({ cause: e }))` (async). Prefer `.catch()` over `errore.tryAsync`.
- Do not catch unexpected exceptions. When one shows up, pick a strategy for that case.
- Replace `try`/`finally` resource cleanup with `await using` + `errore.AsyncDisposableStack` (or `using` + `errore.DisposableStack`) when cleanup is needed.
- At consumer or legacy boundaries that require throws, convert a returned error back to a throw only at that edge: `if (result instanceof Error) throw result`.

## Cursor Cloud specific instructions

Tandem is a pnpm (`pnpm@12.10.1`) + Turborepo monorepo of three publishable **libraries** (`@tanishqkancharla/tandem-core`, `@tanishqkancharla/tandem-server`, `@tanishqkancharla/tandem-react`) plus examples. Standard commands live in the root `package.json` and delegate to Turbo: `pnpm build`, `pnpm lint`, `pnpm type-check`, `pnpm format`, `pnpm test`.

- The default `pnpm test` runs fully in-process: `@tanishqkancharla/tandem-core` uses `fake-indexeddb`, and `@tanishqkancharla/tandem-server` covers `TandemServer` with memory and JSON-file storage.
- The todo example has Hono and Vite development servers. Run its consumer-level tests with `pnpm --filter @tandem/example-todo-web test:e2e`.
- Sync gotcha when writing demos/tests: the sync engine only propagates data for scan windows a client is subscribed to. A client must `subscribe(...)` (or call `pullFromRemote()`) before committed records from another client sharing the same remote will appear locally.

<!-- BEGIN:turborepo-agent-rules -->

# This is NOT the Turborepo you know

Turborepo configuration, task behavior, and CLI commands can vary between installed versions and may differ from your training data. Resolve the `turbo` package from this file's directory or relevant workspace; in monorepos, it may not be visible from the repository root. For example, run `node -p "require.resolve('turbo/package.json')"` from a workspace that depends on `turbo`.

Read `docs/README.md` inside that installed package first, then read the relevant pages from its `docs/` directory before changing Turborepo configuration or commands. Heed deprecation notices. These bundled docs match the installed package version and are available without network access.

This block is written and re-added by `turbo` before repository-scoped commands when an AI agent is detected. In the Turborepo source repository, its template is defined in `crates/turborepo-cli/src/cli/agent_guidance.rs`. Removing the managed block while updates are enabled means a later qualifying invocation will add it again. Set `"agentGuidance": false` in the root `turbo.json` or `turbo.jsonc` to opt out; this does not remove an existing block. Keep the block committed with your work to avoid an uncommitted change on the next agent invocation.
<!-- END:turborepo-agent-rules -->
