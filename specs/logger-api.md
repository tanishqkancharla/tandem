# Logger API

## Problem overview

Tandem currently accepts a `LoggerApi`, but the implementation is console-oriented and message/argument based. The logger should become optional for `TandemClient` callers while still giving core code a structured, scoped logger that can fan out to multiple sinks.

## Solution overview

Replace the old `LoggerApi` shape with a core `Logger` class and a small `LoggerSinkApi`. Logging methods will accept JSON-like objects, merge scope data into each event, and send structured entries to every configured sink. Add console and JSONL sinks as the first concrete outputs.

## Goals

- `TandemClient` construction works without passing a logger and defaults to a new console-backed logger.
- Callers can construct `new Logger({ sinks })` and pass it into `TandemClient`.
- Core code can call `logger.info`, `logger.debug`, `logger.warn`, `logger.log`, and `logger.error` with arbitrary JSON objects.
- `logger.scope("notion", { id })` returns a new logger that prefixes future events with `{ notion: { id } }`.
- `logger.addSink(sink)` returns a new logger with the additional sink without mutating the original logger.
- Multiple sinks receive the same structured event.
- Logger and sink APIs expose a destructor path so resource-owning sinks, especially JSONL sinks, can close cleanly.

## Non-goals

- No migrations or backfills.
- No compatibility layer for the old string-plus-args `LoggerApi` call style.
- No runtime validation of arbitrary logged JSON beyond best-effort serialization at sink boundaries.
- No log-level filtering, formatting configuration, async batching, or transport/retry system in v1.

## Future work

- Add log-level filtering once the API has real usage pressure.
- Add browser-safe JSONL or remote sinks if product needs them.
- Consider richer error serialization if errors become a documented logging input.

## Important files/docs/websites for implementation

- `packages/core/src/utils/Logger.ts` - Current logger type and console implementation; this should become the new `Logger`, `LoggerSinkApi`, `ConsoleLoggerSink`, and `JsonlLoggerSink` home.
- `packages/core/src/TandemClient.ts` - Public constructor accepts the logger and creates scoped loggers for database and sync engine internals.
- `packages/core/src/Database.ts` - Uses `LoggerApi` internally and has storage error logging that must become structured.
- `packages/core/src/sync/SyncEngine.ts` - Most existing logger call sites live here and need object-shaped log events.
- `packages/core/src/index.ts` - Public exports should expose the new logger class and sink APIs instead of the old `LoggerApi`/`ConsoleLogger` API.
- `packages/core/test/fixtures.ts` - Test logging helper currently implements `LoggerApi`; it should switch to the new `Logger` plus JSONL sink or a focused test sink.
- `packages/core/test/TandemClient.spec.ts` - Existing client/sync coverage should continue passing after logger migration.
- `packages/core/package.json` and root `package.json` - Provide verification commands: `pnpm --filter @tanishqkancharla/tandem-core test` and `pnpm --filter @tanishqkancharla/tandem-core type-check`.

## Implementation

### Phase 1: Introduce structured Logger and sink APIs

Replace `LoggerApi` with a concrete immutable `Logger` that owns scope data and sink references. Keep the first phase centered on API behavior and focused unit coverage before migrating all Tandem internals.

```ts
type LogLevel = "debug" | "info" | "warn" | "log" | "error"
type LoggerData = Record<string, unknown>

type LoggerSinkApi = {
	log: (entry: { timestamp: string; level: LogLevel; data: LoggerData }) => void
	destroy?: () => void
}

class Logger {
	constructor(args?: { sinks?: LoggerSinkApi | LoggerSinkApi[] })
	info(data: LoggerData) {
		this.write("info", data)
	}
	scope(name: string, data: LoggerData = {}) {
		return new Logger({
			sinks: this.sinks,
			scopes: { ...this.scopes, [name]: data },
		})
	}
}
```

- [ ] Define `LogLevel`, `LoggerData`, `LoggerEntry`, and `LoggerSinkApi` in `packages/core/src/utils/Logger.ts`.
- [ ] Implement `Logger` with default empty sinks so `new Logger()` is quiet outside of `TandemClient` defaults.
- [ ] Accept `sinks?: LoggerSinkApi | LoggerSinkApi[]` in the constructor for ergonomic single-sink creation.
- [ ] Add `debug`, `info`, `warn`, `log`, and `error`, each accepting one arbitrary JSON-like object and sending `{ timestamp, level, data }` to every sink.
- [ ] Implement `scope(name, data)` so logged data becomes `{ ...scopes, ...data }`, with later `data` able to override a scope key of the same name.
- [ ] Implement `addSink(sink)` as immutable: return a new `Logger` with existing scopes and sinks plus the new sink.
- [ ] Implement `destroy()` on `Logger` that calls `destroy?.()` once for each unique sink.
- [ ] Add focused logger tests that assert scope merging, multiple sink fan-out, `addSink` immutability, and destructor fan-out.
- [ ] Verify `pnpm --filter @tanishqkancharla/tandem-core type-check` passes.

### Phase 2: Add Console and JSONL sinks

Create the two initial sinks against the new sink contract. Keep sink formatting intentionally small: console mirrors structured data for humans, JSONL emits one complete event per line.

```ts
class ConsoleLoggerSink implements LoggerSinkApi {
	log(entry: LoggerEntry) {
		console[entry.level === "debug" ? "debug" : entry.level](entry.data)
	}
}

class JsonlLoggerSink implements LoggerSinkApi {
	log(entry: LoggerEntry) {
		appendFileSync(this.path, `${JSON.stringify(entry)}\n`)
	}
}
```

- [ ] Add `ConsoleLoggerSink` that maps logger levels to the corresponding console method.
- [ ] Add `JsonlLoggerSink` that appends JSON lines containing the full `{ timestamp, level, data }` entry.
- [ ] Decide constructor shape for JSONL as `new JsonlLoggerSink({ filePath })` to keep path options extensible without adding overloads.
- [ ] Serialize non-JSON values defensively at the JSONL boundary so sink writes do not throw for common values such as `Error`.
- [ ] Add tests for console level dispatch with spies and JSONL line output.
- [ ] Verify `pnpm --filter @tanishqkancharla/tandem-core test -- packages/core/test/Logger.spec.ts` passes.

### Phase 3: Make TandemClient logger optional and migrate core call sites

Switch the public client args to `logger?: Logger`, default to a new console-backed logger, and update internal log calls to object data. This keeps the current client behavior of emitting logs when no logger is supplied while preserving structured diagnostics for tests and app consumers.

```ts
const logger = args.logger ?? new Logger({ sinks: new ConsoleLoggerSink() })

this.logger = logger
this.logger.info({ message: "pulling from remote" })

this.db = new Database({
	logger: this.logger.scope("db"),
})
```

- [ ] Update `TandemClientArgs.logger` to `logger?: Logger`.
- [ ] Default missing loggers to `new Logger({ sinks: new ConsoleLoggerSink() })`.
- [ ] Scope the client logger with stable client-level data, likely `{ clientId }`, after the client id is generated.
- [ ] Update `DatabaseArgs` and `SyncEngineArgs` to accept `Logger`.
- [ ] Convert all string/args logger calls in `TandemClient.ts`, `Database.ts`, and `SyncEngine.ts` to single-object calls with a `message` field and structured details.
- [ ] Replace the direct `console.warn` in `TandemClient.disconnect()` with `this.logger.warn({ message: "attempted to disconnect without a remote server configured" })`.
- [ ] Update test fixtures to use `new Logger({ sinks: new JsonlLoggerSink({ filePath }) })` or a minimal in-memory sink where assertions need captured events.
- [ ] Verify `pnpm --filter @tanishqkancharla/tandem-core test` passes.

### Phase 4: Update public exports and docs references

Remove the old public logger exports and expose the new API from the package root. Update user-facing examples only where they mention logger construction.

```ts
export {
	Logger,
	ConsoleLoggerSink,
	JsonlLoggerSink,
	type LoggerSinkApi,
	type LoggerEntry,
	type LogLevel,
} from "./utils/Logger"
```

- [ ] Export `Logger`, `ConsoleLoggerSink`, `JsonlLoggerSink`, `LoggerSinkApi`, `LoggerEntry`, and `LogLevel` from `packages/core/src/index.ts`.
- [ ] Remove exports for `LoggerApi`, `ConsoleLogger`, and `rootLogger`.
- [ ] Search for `LoggerApi`, `ConsoleLogger`, and `rootLogger` and remove all remaining references.
- [ ] Update docs examples only if they currently document the logger API.
- [ ] Verify `pnpm --filter @tanishqkancharla/tandem-core type-check` passes.
- [ ] Verify `pnpm --filter @tanishqkancharla/tandem-core test` passes.
