import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, test, vi } from "vitest"
import {
	ConsoleLoggerSink,
	Logger,
	type LoggerEntry,
	type LoggerSinkApi,
} from "../src/utils/Logger"
import { JsonlLoggerSink } from "../src/utils/JsonlLoggerSink"

function createMemorySink() {
	const entries: LoggerEntry[] = []
	const sink: LoggerSinkApi = {
		log: (entry) => {
			entries.push(entry)
		},
		destroy: vi.fn(),
	}
	return { entries, sink }
}

describe("Logger", () => {
	test("sends scoped structured events to every sink", () => {
		const first = createMemorySink()
		const second = createMemorySink()
		const logger = new Logger({ sinks: [first.sink, second.sink] })
			.scope("notion", { id: "notion-1" })
			.scope("workspace", { id: "workspace-1" })

		logger.info({ message: "hello" })

		expect(first.entries).toEqual([
			{
				timestamp: expect.any(String),
				level: "info",
				data: {
					notion: { id: "notion-1" },
					workspace: { id: "workspace-1" },
					message: "hello",
				},
			},
		])
		expect(second.entries).toEqual(first.entries)
	})

	test("returns a new logger when adding a sink", () => {
		const original = createMemorySink()
		const added = createMemorySink()
		const logger = new Logger({ sinks: original.sink })
		const loggerWithAddedSink = logger.addSink(added.sink)

		logger.log({ message: "original only" })
		loggerWithAddedSink.warn({ message: "both sinks" })

		expect(original.entries.map((entry) => entry.data.message)).toEqual([
			"original only",
			"both sinks",
		])
		expect(added.entries.map((entry) => entry.data.message)).toEqual([
			"both sinks",
		])
	})

	test("destroys each sink once", () => {
		const first = createMemorySink()
		const second = createMemorySink()
		const logger = new Logger({ sinks: [first.sink, first.sink] }).addSink(
			second.sink,
		)

		logger.destroy()

		expect(first.sink.destroy).toHaveBeenCalledTimes(1)
		expect(second.sink.destroy).toHaveBeenCalledTimes(1)
	})

	test("console sink dispatches to the matching console level", () => {
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {})

		new ConsoleLoggerSink().log({
			timestamp: "2026-05-17T00:00:00.000Z",
			level: "error",
			data: { message: "boom" },
		})

		expect(errorSpy).toHaveBeenCalledWith({ message: "boom" })
		errorSpy.mockRestore()
	})

	test("jsonl sink writes structured lines and serializes errors", () => {
		const dir = mkdtempSync(join(tmpdir(), "tandem-logger-"))
		const filePath = join(dir, "logs.jsonl")
		try {
			const logger = new Logger({
				sinks: new JsonlLoggerSink({ filePath }),
			})

			logger.error({
				message: "failed",
				error: new Error("nope"),
				attempt: 1n,
			})

			const [line] = readFileSync(filePath, "utf8").trim().split("\n")
			const entry = JSON.parse(line)

			expect(entry).toMatchObject({
				level: "error",
				data: {
					message: "failed",
					error: {
						name: "Error",
						message: "nope",
					},
					attempt: "1",
				},
			})
			expect(entry.timestamp).toEqual(expect.any(String))
		} finally {
			rmSync(dir, { recursive: true, force: true })
		}
	})
})
