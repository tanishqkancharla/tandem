# Phase 1: Remove the Node logger

**Today**

Core exports [[packages/core/src/node/JsonlLoggerSink.ts#JsonlLoggerSink]] at `@tanishqkancharla/tandem-core/node`. It appends one JSON line per log entry to a file, using [[packages/core/src/utils/Logger.ts#serializeLogValue]] to turn errors and bigints into JSON. No package, example, or test besides its own uses it. [[packages/core/tsconfig.node.json]] exists only to check this one file with Node types.

**Proposed**

Delete the sink, its subpath, its tsconfig, and the serializer only it calls. Apps that want a log file write a sink against [[packages/core/src/utils/Logger.ts#LoggerSinkApi]], which core already exports. This removes the only Node-only code in core.

Logging keeps its shape. Only the optional file sink disappears:

```callstack [Logging an entry]
 Logger.log [[packages/core/src/utils/Logger.ts#Logger]]
 ├── ConsoleLoggerSink.log # print to the console [[packages/core/src/utils/Logger.ts#ConsoleLoggerSink]]
-└── JsonlLoggerSink.log # append a JSON line to filePath [[packages/core/src/node/JsonlLoggerSink.ts#JsonlLoggerSink]]
-    └── serializeLogValue # turn errors and bigints into JSON [[packages/core/src/utils/Logger.ts#serializeLogValue]]
+└── app sink .log # whatever the app passes in `sinks`
```

An app that wants a file log writes a few lines of its own. No doc covers logging today, so the `/node` row in the core README gives way to this example:

```ts
import { appendFileSync } from "node:fs"
import type { LoggerSinkApi } from "@tanishqkancharla/tandem-core"

const fileSink = (filePath: string): LoggerSinkApi => ({
	log: (entry) => appendFileSync(filePath, `${JSON.stringify(entry)}\n`),
})
```

`JSON.stringify` writes an `Error` as `{}`. That is the app's choice to make in its own sink. Core does not keep `serializeLogValue` for a sink it no longer ships.

The phase deletes these pieces:

| Piece | Where |
| --- | --- |
| Sink | `packages/core/src/node/JsonlLoggerSink.ts` |
| Serializer | `serializeLogValue` in `packages/core/src/utils/Logger.ts` |
| Test | "jsonl sink writes structured lines and serializes errors" in `packages/core/src/utils/Logger.spec.ts` |
| Subpath | `"./node"` in `packages/core/package.json` `exports` |
| Checks | `tsconfig.node.json` and its `tsc -p` runs in `build`, `type-check`, and `lint` |
| Lint | `packages/core/src/node/**` overrides in `.oxlintrc.json` and `--exclude-dir=node` in `check:globals` |
| Docs | the `/node` row in `packages/core/README.md` |

Core's build drops one `tsc` pass:

```callstack [pnpm --filter @tanishqkancharla/tandem-core build]
 tsc # shared code [[packages/core/tsconfig.json]]
 tsc -p tsconfig.browser.json # src/browser [[packages/core/tsconfig.browser.json]]
-tsc -p tsconfig.node.json # src/node [[packages/core/tsconfig.node.json]]
```

Removing `/node` breaks its import path. No released version or app uses it.
