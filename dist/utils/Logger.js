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
//# sourceMappingURL=Logger.js.map