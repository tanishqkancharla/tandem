import type { LoggerEntry, LoggerSinkApi } from "./Logger.js";
export declare class JsonlLoggerSink implements LoggerSinkApi {
    private readonly filePath;
    constructor({ filePath }: {
        filePath: string;
    });
    log(entry: LoggerEntry): void;
}
//# sourceMappingURL=JsonlLoggerSink.d.ts.map