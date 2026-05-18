export type LogLevel = "debug" | "info" | "warn" | "log" | "error"

export type LoggerData = Record<string, unknown>

export type LoggerEntry = {
	timestamp: string
	level: LogLevel
	data: LoggerData
}

export type LoggerSinkApi = {
	log: (entry: LoggerEntry) => void
	destroy?: () => void
}

type LoggerArgs = {
	sinks?: LoggerSinkApi | readonly LoggerSinkApi[]
	scopes?: LoggerData
}

function isSinkArray(
	sinks: LoggerSinkApi | readonly LoggerSinkApi[],
): sinks is readonly LoggerSinkApi[] {
	return Array.isArray(sinks)
}

function toSinks(
	sinks: LoggerSinkApi | readonly LoggerSinkApi[] | undefined,
): readonly LoggerSinkApi[] {
	if (!sinks) return []
	return isSinkArray(sinks) ? sinks : [sinks]
}

function createLogEntry(
	level: LogLevel,
	scopes: LoggerData,
	data: LoggerData,
): LoggerEntry {
	return {
		timestamp: new Date().toISOString(),
		level,
		data: {
			...scopes,
			...data,
		},
	}
}

export class Logger {
	private readonly sinks: readonly LoggerSinkApi[]
	private readonly scopes: LoggerData

	constructor({ sinks, scopes = {} }: LoggerArgs = {}) {
		this.sinks = toSinks(sinks)
		this.scopes = scopes
	}

	debug(data: LoggerData) {
		this.write("debug", data)
	}

	info(data: LoggerData) {
		this.write("info", data)
	}

	warn(data: LoggerData) {
		this.write("warn", data)
	}

	log(data: LoggerData) {
		this.write("log", data)
	}

	error(data: LoggerData) {
		this.write("error", data)
	}

	scope(name: string, data: LoggerData = {}): Logger {
		return new Logger({
			sinks: this.sinks,
			scopes: {
				...this.scopes,
				[name]: data,
			},
		})
	}

	addSink(sink: LoggerSinkApi): Logger {
		return new Logger({
			sinks: [...this.sinks, sink],
			scopes: this.scopes,
		})
	}

	destroy() {
		for (const sink of new Set(this.sinks)) {
			sink.destroy?.()
		}
	}

	private write(level: LogLevel, data: LoggerData) {
		const entry = createLogEntry(level, this.scopes, data)
		for (const sink of this.sinks) {
			sink.log(entry)
		}
	}
}

export class ConsoleLoggerSink implements LoggerSinkApi {
	log(entry: LoggerEntry) {
		console[entry.level](entry.data)
	}
}
