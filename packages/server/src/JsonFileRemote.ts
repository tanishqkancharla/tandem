import { mkdir, readFile, writeFile } from "node:fs/promises"
import { dirname } from "node:path"
import type {
	AnySchema,
	CollectionName,
	EncodedQuery,
	Mutation,
	Patch,
} from "@get-halo/tandem-types"
import { InMemoryRemoteStore } from "./InMemoryRemoteStore"
import { RemoteServer, type RemoteStore } from "./RemoteServer"

export type JsonFileRemoteArgs = {
	filePath: string
}

type JsonFileRecords<Schema extends AnySchema> = Partial<
	Record<CollectionName<Schema>, Schema[CollectionName<Schema>][]>
>

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isNotFoundError(error: unknown): boolean {
	return (
		typeof error === "object" &&
		error !== null &&
		"code" in error &&
		error.code === "ENOENT"
	)
}

function parseJsonFile<Schema extends AnySchema>(
	filePath: string,
	raw: string,
): JsonFileRecords<Schema> {
	let parsed: unknown
	try {
		parsed = JSON.parse(raw)
	} catch {
		throw new Error(`JsonFileRemote could not parse ${filePath} as JSON`)
	}

	if (!isRecord(parsed)) {
		throw new Error(
			`JsonFileRemote expected ${filePath} to be a JSON object of collection arrays`,
		)
	}

	const records: JsonFileRecords<Schema> = {}
	for (const [collection, collectionRecords] of Object.entries(parsed)) {
		if (!Array.isArray(collectionRecords)) {
			throw new Error(
				`JsonFileRemote expected collection "${collection}" in ${filePath} to be an array of records`,
			)
		}
		records[collection as CollectionName<Schema>] =
			collectionRecords as Schema[CollectionName<Schema>][]
	}

	return records
}

class JsonFileRemoteStore<
	Schema extends AnySchema,
> implements RemoteStore<Schema> {
	private readonly memory = new InMemoryRemoteStore<Schema>()
	private readonly ready: Promise<void>
	private queue: Promise<void> = Promise.resolve()

	constructor(private readonly filePath: string) {
		this.ready = this.loadFromDisk()
	}

	applyMutations(mutations: Mutation<Schema>[]): Promise<void> {
		return this.run(async () => {
			await this.ready
			await this.memory.applyMutations(mutations)
			await this.writeToDisk()
		})
	}

	readSnapshot(queries: EncodedQuery<Schema>[]): Promise<Patch<Schema>> {
		return this.run(async () => {
			await this.ready
			return this.memory.readSnapshot(queries)
		})
	}

	private run<T>(fn: () => Promise<T>): Promise<T> {
		const result = this.queue.then(fn)
		this.queue = result.then(
			() => undefined,
			() => undefined,
		)
		return result
	}

	private async loadFromDisk(): Promise<void> {
		try {
			const raw = await readFile(this.filePath, "utf8")
			this.memory.loadRecords(parseJsonFile<Schema>(this.filePath, raw))
		} catch (error) {
			if (!isNotFoundError(error)) {
				throw error
			}
		}
	}

	private async writeToDisk(): Promise<void> {
		await mkdir(dirname(this.filePath), { recursive: true })
		await writeFile(
			this.filePath,
			`${JSON.stringify(this.memory.dumpRecords(), null, 2)}\n`,
		)
	}
}

export class JsonFileRemote<
	Schema extends AnySchema = AnySchema,
> extends RemoteServer<Schema> {
	constructor(args: JsonFileRemoteArgs) {
		super({ store: new JsonFileRemoteStore<Schema>(args.filePath) })
	}
}
