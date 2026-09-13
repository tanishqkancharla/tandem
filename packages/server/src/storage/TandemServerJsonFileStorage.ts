import crypto from "node:crypto"
import fs from "node:fs/promises"
import path from "node:path"
import type { AnySchema } from "@tanishqkancharla/tandem-core"
import * as errore from "errore"
import { InMemoryTupleStorage } from "tuple-database"
import type { ScanStorageArgs, WriteOps } from "tuple-database"
import type { TandemTuple, TandemServerStorageApi } from "./TandemServerStorage"

export type TandemServerJsonFileStorageArgs = {
	filePath: string
}

type StoredTandemTuple = {
	key: ["record", collection: string, id: string | number]
	value: Record<string, unknown> & { id: string | number }
}

type FileOperation =
	| "clean up temporary file for"
	| "create directory for"
	| "publish"
	| "read"
	| "write"

class TandemServerJsonFileStorageError extends errore.createTaggedError({
	name: "TandemServerJsonFileStorageError",
	message: "Tandem server JSON storage failed to $operation $filePath",
}) {}

function runFileOperation<T>({
	operation,
	filePath,
	promise,
}: {
	operation: FileOperation
	filePath: string
	promise: Promise<T>
}) {
	return promise.catch(
		(cause) =>
			new TandemServerJsonFileStorageError({ operation, filePath, cause }),
	)
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isStoredTandemTuple(value: unknown): value is StoredTandemTuple {
	if (!isRecord(value) || !Array.isArray(value.key)) return false
	if (value.key.length !== 3 || value.key[0] !== "record") return false
	if (typeof value.key[1] !== "string") return false
	if (typeof value.key[2] !== "string" && typeof value.key[2] !== "number") {
		return false
	}
	if (!isRecord(value.value)) return false

	return value.value.id === value.key[2]
}

function isNotFoundError(value: unknown): boolean {
	return isRecord(value) && value.code === "ENOENT"
}

function parseTuples({ filePath, raw }: { filePath: string; raw: string }) {
	const parsed = errore.try({
		// Wrap the unknown JSON value so Error remains a discriminable union.
		try: () => ({ value: JSON.parse(raw) as unknown }),
		catch: (cause) =>
			new TandemServerJsonFileStorageError({
				operation: "parse",
				filePath,
				cause,
			}),
	})
	if (parsed instanceof Error) return parsed
	if (Array.isArray(parsed.value) && parsed.value.every(isStoredTandemTuple)) {
		return parsed.value
	}

	return new TandemServerJsonFileStorageError({
		operation: "parse",
		filePath,
		cause: new Error("Expected a JSON array of Tandem tuples"),
	})
}

export class TandemServerJsonFileStorage<
	Schema extends AnySchema = AnySchema,
> implements TandemServerStorageApi<Schema> {
	private memory = new InMemoryTupleStorage()
	private initialization:
		| Promise<TandemServerJsonFileStorageError | undefined>
		| undefined
	private queue: Promise<void> = Promise.resolve()

	constructor(private readonly args: TandemServerJsonFileStorageArgs) {}

	scan(args?: ScanStorageArgs): Promise<TandemTuple<Schema>[]> {
		return this.run(async () => {
			const initialized = await this.initialize()
			if (initialized instanceof Error) return initialized

			// tuple-database's in-memory storage erases its tuple generic. The data
			// entered this adapter through typed writes or the validated JSON boundary.
			return this.scanMemory(this.memory, args)
		})
	}

	commit(writes: WriteOps<TandemTuple<Schema>>): Promise<void> {
		return this.run(async () => {
			const initialized = await this.initialize()
			if (initialized instanceof Error) return initialized

			const nextMemory = new InMemoryTupleStorage()
			nextMemory.commit({ set: this.memory.scan() })
			nextMemory.commit(writes)

			const persisted = await this.writeToDisk(this.scanMemory(nextMemory))
			if (persisted instanceof Error) return persisted

			this.memory = nextMemory
		})
	}

	close(): Promise<void> {
		return this.run(() => undefined)
	}

	private run<T>(
		operation: () =>
			| Promise<T | TandemServerJsonFileStorageError>
			| T
			| TandemServerJsonFileStorageError,
	): Promise<T> {
		const result = this.queue.then(async () => {
			const operationResult = await operation()
			if (operationResult instanceof Error) throw operationResult
			return operationResult
		})
		this.queue = result.then(
			() => undefined,
			() => undefined,
		)
		return result
	}

	private initialize() {
		this.initialization ??= this.loadFromDisk()
		return this.initialization
	}

	private scanMemory(memory: InMemoryTupleStorage, args?: ScanStorageArgs) {
		return memory.scan(args) as TandemTuple<Schema>[]
	}

	private async loadFromDisk() {
		const raw = await runFileOperation({
			operation: "read",
			filePath: this.args.filePath,
			promise: fs.readFile(this.args.filePath, "utf8"),
		})
		if (raw instanceof Error && isNotFoundError(raw.cause)) return undefined
		if (raw instanceof Error) return raw

		const tuples = parseTuples({ filePath: this.args.filePath, raw })
		if (tuples instanceof Error) return tuples

		this.memory.commit({ set: tuples })
	}

	private async writeToDisk(tuples: TandemTuple<Schema>[]) {
		const serialized = errore.try({
			try: () => `${JSON.stringify(tuples, undefined, 2)}\n`,
			catch: (cause) =>
				new TandemServerJsonFileStorageError({
					operation: "serialize",
					filePath: this.args.filePath,
					cause,
				}),
		})
		if (serialized instanceof Error) return serialized

		const directory = await runFileOperation({
			operation: "create directory for",
			filePath: this.args.filePath,
			promise: fs.mkdir(path.dirname(this.args.filePath), { recursive: true }),
		})
		if (directory instanceof Error) return directory

		const temporaryFilePath = `${this.args.filePath}.${crypto.randomUUID()}.tmp`
		await using cleanup = new errore.AsyncDisposableStack()
		cleanup.defer(async () => {
			const removed = await runFileOperation({
				operation: "clean up temporary file for",
				filePath: this.args.filePath,
				promise: fs.rm(temporaryFilePath, { force: true }),
			})
			if (removed instanceof Error) console.warn(removed)
		})

		const written = await runFileOperation({
			operation: "write",
			filePath: this.args.filePath,
			promise: fs.writeFile(temporaryFilePath, serialized),
		})
		if (written instanceof Error) return written

		const renamed = await runFileOperation({
			operation: "publish",
			filePath: this.args.filePath,
			promise: fs.rename(temporaryFilePath, this.args.filePath),
		})
		if (renamed instanceof Error) return renamed
	}
}
