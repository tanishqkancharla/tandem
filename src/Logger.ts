export type LoggerApi = {
	log: (message: string, ...args: any[]) => void
	error: (message: string, ...args: any[]) => void
	warn: (message: string, ...args: any[]) => void
	info: (message: string, ...args: any[]) => void

	scope: (name: string) => LoggerApi
}

export class ConsoleLogger implements LoggerApi {
	private readonly prefix: string

	constructor(private readonly names: string[] = []) {
		this.prefix = names.map((name) => `(${name})`).join(" ")
	}

	log(message: string, ...args: any[]) {
		console.log(this.prefix, message, ...args)
	}

	error(message: string, ...args: any[]) {
		console.error(this.prefix, message, ...args)
	}

	warn(message: string, ...args: any[]) {
		console.warn(this.prefix, message, ...args)
	}

	info(message: string, ...args: any[]) {
		console.info(this.prefix, message, ...args)
	}

	scope(name: string): LoggerApi {
		return new ConsoleLogger([...this.names, name])
	}
}

export const rootLogger = new ConsoleLogger()
