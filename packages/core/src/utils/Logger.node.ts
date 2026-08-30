import { appendFileSync } from "node:fs"
import {
	serializeLogValue,
	type LoggerEntry,
	type LoggerSinkApi,
} from "./Logger"

export type JsonlLoggerSinkArgs = {
	filePath: string
}

export class JsonlLoggerSink implements LoggerSinkApi {
	private readonly filePath: string

	constructor({ filePath }: JsonlLoggerSinkArgs) {
		this.filePath = filePath
	}

	log(entry: LoggerEntry) {
		appendFileSync(
			this.filePath,
			`${JSON.stringify(serializeLogValue(entry))}\n`,
		)
	}
}
