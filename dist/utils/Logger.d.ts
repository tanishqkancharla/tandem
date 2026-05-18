export type LogLevel = "debug" | "info" | "warn" | "log" | "error";
export type LoggerData = Record<string, unknown>;
export type LoggerEntry = {
    timestamp: string;
    level: LogLevel;
    data: LoggerData;
};
export type LoggerSinkApi = {
    log: (entry: LoggerEntry) => void;
    destroy?: () => void;
};
type LoggerArgs = {
    sinks?: LoggerSinkApi | readonly LoggerSinkApi[];
    scopes?: LoggerData;
};
export declare class Logger {
    private readonly sinks;
    private readonly scopes;
    constructor({ sinks, scopes }?: LoggerArgs);
    debug(data: LoggerData): void;
    info(data: LoggerData): void;
    warn(data: LoggerData): void;
    log(data: LoggerData): void;
    error(data: LoggerData): void;
    scope(name: string, data?: LoggerData): Logger;
    addSink(sink: LoggerSinkApi): Logger;
    destroy(): void;
    private write;
}
export declare class ConsoleLoggerSink implements LoggerSinkApi {
    log(entry: LoggerEntry): void;
}
export declare class JsonlLoggerSink implements LoggerSinkApi {
    private readonly filePath;
    constructor({ filePath }: {
        filePath: string;
    });
    log(entry: LoggerEntry): void;
}
export {};
//# sourceMappingURL=Logger.d.ts.map