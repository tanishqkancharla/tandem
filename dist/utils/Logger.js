import { appendFileSync } from "node:fs";
function isSinkArray(sinks) {
    return Array.isArray(sinks);
}
function toSinks(sinks) {
    if (!sinks)
        return [];
    return isSinkArray(sinks) ? sinks : [sinks];
}
function createLogEntry(level, scopes, data) {
    return {
        timestamp: new Date().toISOString(),
        level,
        data: {
            ...scopes,
            ...data,
        },
    };
}
function serializeLogValue(value, seen = new WeakSet()) {
    if (value instanceof Error) {
        return {
            name: value.name,
            message: value.message,
            stack: value.stack,
        };
    }
    if (typeof value === "bigint") {
        return value.toString();
    }
    if (!value || typeof value !== "object") {
        return value;
    }
    if (seen.has(value)) {
        return "[Circular]";
    }
    seen.add(value);
    if (Array.isArray(value)) {
        return value.map((item) => serializeLogValue(item, seen));
    }
    return Object.fromEntries(Object.entries(value).map(([key, entryValue]) => [
        key,
        serializeLogValue(entryValue, seen),
    ]));
}
export class Logger {
    sinks;
    scopes;
    constructor({ sinks, scopes = {} } = {}) {
        this.sinks = toSinks(sinks);
        this.scopes = scopes;
    }
    debug(data) {
        this.write("debug", data);
    }
    info(data) {
        this.write("info", data);
    }
    warn(data) {
        this.write("warn", data);
    }
    log(data) {
        this.write("log", data);
    }
    error(data) {
        this.write("error", data);
    }
    scope(name, data = {}) {
        return new Logger({
            sinks: this.sinks,
            scopes: {
                ...this.scopes,
                [name]: data,
            },
        });
    }
    addSink(sink) {
        return new Logger({
            sinks: [...this.sinks, sink],
            scopes: this.scopes,
        });
    }
    destroy() {
        for (const sink of new Set(this.sinks)) {
            sink.destroy?.();
        }
    }
    write(level, data) {
        const entry = createLogEntry(level, this.scopes, data);
        for (const sink of this.sinks) {
            sink.log(entry);
        }
    }
}
export class ConsoleLoggerSink {
    log(entry) {
        console[entry.level](entry.data);
    }
}
export class JsonlLoggerSink {
    filePath;
    constructor({ filePath }) {
        this.filePath = filePath;
    }
    log(entry) {
        appendFileSync(this.filePath, `${JSON.stringify(serializeLogValue(entry))}\n`);
    }
}
//# sourceMappingURL=Logger.js.map