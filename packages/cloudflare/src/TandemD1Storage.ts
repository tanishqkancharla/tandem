import type {
	AnySchema,
	CollectionName,
	MutationId,
} from "@tanishqkancharla/tandem-core"
import type {
	TandemServerStorageApi,
	TandemTuple,
} from "@tanishqkancharla/tandem-server"
import * as errore from "errore"
import { InMemoryTupleStorage } from "tuple-database"
import type { ScanStorageArgs, Tuple, WriteOps } from "tuple-database"

/** The subset of Cloudflare's `D1Database` binding this adapter uses. */
export interface TandemD1Database {
	prepare(query: string): TandemD1PreparedStatement
	batch(statements: TandemD1PreparedStatement[]): Promise<unknown[]>
}

export interface TandemD1PreparedStatement {
	bind(...values: unknown[]): TandemD1PreparedStatement
	all(): Promise<{ results: unknown[] }>
}

export type TandemD1ColumnType =
	| "text"
	| "integer"
	| "real"
	| "boolean"
	| "json"

export type TandemD1CollectionConfig<Record> = {
	/** SQL table holding this collection. Each record field is one column. */
	table: string
	columns: { [Field in keyof Record & string]-?: TandemD1ColumnType }
}

export type TandemD1StorageArgs<Schema extends AnySchema> = {
	db: TandemD1Database
	collections: {
		[Collection in CollectionName<Schema>]: TandemD1CollectionConfig<
			Schema[Collection]
		>
	}
	/**
	 * Table holding each Tandem client's last applied mutation.
	 * Create it with `tandemD1ClientTableSql(table)`.
	 * @default "tandem_clients"
	 */
	clientTable?: string
}

export class TandemD1StorageError extends errore.createTaggedError({
	name: "TandemD1StorageError",
	message: "Tandem D1 storage $operation failed: $reason",
}) {}

const identifierPattern = /^[A-Za-z_][A-Za-z0-9_]*$/

function quoteIdentifier(name: string) {
	if (!identifierPattern.test(name)) {
		throw new Error(`Invalid SQL identifier "${name}"`)
	}
	return `"${name}"`
}

/**
 * SQL for the client acknowledgement table. Each acknowledgement commits in the
 * same D1 batch as the records the mutation wrote.
 */
export function tandemD1ClientTableSql(table = "tandem_clients") {
	return `CREATE TABLE IF NOT EXISTS ${quoteIdentifier(table)} (
	client_id TEXT PRIMARY KEY,
	last_mutation_id INTEGER NOT NULL CHECK (last_mutation_id > 0)
);`
}

type ResolvedCollection = {
	name: string
	table: string
	columns: [field: string, type: TandemD1ColumnType][]
	idType: TandemD1ColumnType
}

function commonPrefix(args: ScanStorageArgs): Tuple {
	const start = args.gt ?? args.gte ?? []
	const end = args.lt ?? args.lte ?? []
	const prefix: Tuple = []
	for (let index = 0; index < Math.min(start.length, end.length); index++) {
		if (start[index] !== end[index]) break
		prefix.push(start[index])
	}
	return prefix
}

function encodeColumn(type: TandemD1ColumnType, value: unknown) {
	if (value === undefined || value === null) return null
	switch (type) {
		case "text":
			return typeof value === "string" ? value : new Error("expected string")
		case "integer":
			return Number.isSafeInteger(value) ? value : new Error("expected integer")
		case "real":
			return typeof value === "number" && Number.isFinite(value)
				? value
				: new Error("expected number")
		case "boolean":
			return typeof value === "boolean"
				? Number(value)
				: new Error("expected boolean")
		case "json":
			return JSON.stringify(value)
	}
}

function decodeColumn(type: TandemD1ColumnType, value: unknown) {
	if (value === null || value === undefined) return undefined
	switch (type) {
		case "boolean":
			return value === 1 || value === true
		case "json":
			return JSON.parse(String(value)) as unknown
		default:
			return value
	}
}

/**
 * Tandem server storage over ordinary D1 tables. Records stay in the app's own
 * tables, so plain SQL writes elsewhere in the app remain visible to sync.
 */
export class TandemD1Storage<
	Schema extends AnySchema,
> implements TandemServerStorageApi<Schema> {
	private readonly db: TandemD1Database
	private readonly collections = new Map<string, ResolvedCollection>()
	private readonly clientTable: string

	constructor(args: TandemD1StorageArgs<Schema>) {
		this.db = args.db
		this.clientTable = quoteIdentifier(args.clientTable ?? "tandem_clients")
		const configs = args.collections as Record<
			string,
			TandemD1CollectionConfig<Record<string, unknown>>
		>
		for (const [name, config] of Object.entries(configs)) {
			const columns = Object.entries(config.columns) as [
				string,
				TandemD1ColumnType,
			][]
			for (const [field] of columns) quoteIdentifier(field)
			const idType = config.columns.id
			if (idType !== "text" && idType !== "integer") {
				throw new Error(
					`Collection "${name}" needs a text or integer "id" column`,
				)
			}
			this.collections.set(name, {
				name,
				table: quoteIdentifier(config.table),
				columns,
				idType,
			})
		}
	}

	/** Names of the collections this storage can read and write. */
	get collectionNames(): string[] {
		return [...this.collections.keys()]
	}

	async scan(args: ScanStorageArgs = {}): Promise<TandemTuple<Schema>[]> {
		const tuples = await this.loadCandidates(commonPrefix(args))
		if (tuples instanceof Error) throw tuples
		// Rows are loaded by table; tuple-database applies the exact bounds,
		// ordering, direction, and limit.
		const memory = new InMemoryTupleStorage()
		memory.commit({ set: tuples })
		return memory.scan(args) as TandemTuple<Schema>[]
	}

	async commit(writes: WriteOps<TandemTuple<Schema>>): Promise<void> {
		const statements = errore.try({
			try: () => this.prepareWrites(writes),
			catch: (cause) =>
				new TandemD1StorageError({
					operation: "commit",
					reason: cause instanceof Error ? cause.message : "invalid write",
					cause,
				}),
		})
		if (statements instanceof Error) throw statements
		if (!statements.length) return
		const committed = await this.db.batch(statements).catch(
			(cause) =>
				new TandemD1StorageError({
					operation: "commit",
					reason: "D1 rejected the batch",
					cause,
				}),
		)
		if (committed instanceof Error) throw committed
	}

	async close(): Promise<void> {}

	private async loadCandidates(prefix: Tuple) {
		const [namespace, name, id] = prefix
		const loads: Promise<{ key: Tuple; value: unknown }[]>[] = []
		if (namespace === undefined || namespace === "client") {
			loads.push(this.loadClients(typeof name === "string" ? name : undefined))
		}
		if (namespace === undefined || namespace === "record") {
			const selected =
				typeof name === "string"
					? [this.collections.get(name)].filter((value) => value !== undefined)
					: [...this.collections.values()]
			for (const collection of selected) {
				loads.push(
					this.loadRecords(collection, prefix.length >= 3 ? id : undefined),
				)
			}
		}
		const loaded = await Promise.all(loads).catch(
			(cause) =>
				new TandemD1StorageError({
					operation: "scan",
					reason: "D1 query failed",
					cause,
				}),
		)
		if (loaded instanceof Error) return loaded
		return loaded.flat()
	}

	private async loadClients(clientId: string | undefined) {
		const statement =
			clientId === undefined
				? this.db.prepare(
						`SELECT client_id, last_mutation_id FROM ${this.clientTable}`,
					)
				: this.db
						.prepare(
							`SELECT client_id, last_mutation_id FROM ${this.clientTable} WHERE client_id = ?`,
						)
						.bind(clientId)
		const { results } = await statement.all()
		return (results as { client_id: string; last_mutation_id: number }[]).map(
			(row) => ({
				key: ["client", row.client_id],
				value: { lastMutationId: row.last_mutation_id as MutationId },
			}),
		)
	}

	private async loadRecords(collection: ResolvedCollection, id: unknown) {
		const columns = collection.columns
			.map(([field]) => quoteIdentifier(field))
			.join(", ")
		const statement =
			id === undefined
				? this.db.prepare(`SELECT ${columns} FROM ${collection.table}`)
				: this.db
						.prepare(
							`SELECT ${columns} FROM ${collection.table} WHERE "id" = ?`,
						)
						.bind(id)
		const { results } = await statement.all()
		return (results as Record<string, unknown>[]).map((row) => {
			const value: Record<string, unknown> = {}
			for (const [field, type] of collection.columns) {
				const decoded = decodeColumn(type, row[field])
				if (decoded !== undefined) value[field] = decoded
			}
			return { key: ["record", collection.name, value.id] as Tuple, value }
		})
	}

	private prepareWrites(writes: WriteOps<TandemTuple<Schema>>) {
		const statements: TandemD1PreparedStatement[] = []
		// Match tuple-database: removes apply before sets in one commit.
		for (const key of writes.remove ?? []) {
			statements.push(this.prepareRemove(key as Tuple))
		}
		for (const { key, value } of writes.set ?? []) {
			statements.push(this.prepareSet(key as Tuple, value))
		}
		return statements
	}

	private resolveRecordKey(key: Tuple) {
		const [namespace, name, id, ...rest] = key
		const collection =
			namespace === "record" && typeof name === "string"
				? this.collections.get(name)
				: undefined
		if (!collection || rest.length) {
			throw new Error(`Unsupported tuple key ${JSON.stringify(key)}`)
		}
		const encodedId = encodeColumn(collection.idType, id)
		if (encodedId instanceof Error || encodedId === null) {
			throw new Error(`Invalid id for collection "${collection.name}"`)
		}
		return { collection, id: encodedId }
	}

	private prepareRemove(key: Tuple) {
		if (key[0] === "client" && typeof key[1] === "string" && key.length === 2) {
			return this.db
				.prepare(`DELETE FROM ${this.clientTable} WHERE client_id = ?`)
				.bind(key[1])
		}
		const { collection, id } = this.resolveRecordKey(key)
		return this.db
			.prepare(`DELETE FROM ${collection.table} WHERE "id" = ?`)
			.bind(id)
	}

	private prepareSet(key: Tuple, value: unknown) {
		if (key[0] === "client" && typeof key[1] === "string" && key.length === 2) {
			const lastMutationId = (value as { lastMutationId?: unknown })
				?.lastMutationId
			if (!Number.isSafeInteger(lastMutationId)) {
				throw new Error("Invalid client acknowledgement")
			}
			// Advance acknowledgements one mutation at a time. A stale or duplicate
			// writer produces NULL, violating NOT NULL and aborting the whole batch.
			return this.db
				.prepare(
					`INSERT INTO ${this.clientTable} (client_id, last_mutation_id)
SELECT ?1, CASE WHEN COALESCE((SELECT last_mutation_id FROM ${this.clientTable} WHERE client_id = ?1), 0) = ?2 - 1 THEN ?2 ELSE NULL END
WHERE true
ON CONFLICT (client_id) DO UPDATE SET last_mutation_id = excluded.last_mutation_id`,
				)
				.bind(key[1], lastMutationId)
		}

		const { collection, id } = this.resolveRecordKey(key)
		if (typeof value !== "object" || value === null || Array.isArray(value)) {
			throw new Error(`Invalid record for collection "${collection.name}"`)
		}
		const record = value as Record<string, unknown>
		for (const field of Object.keys(record)) {
			if (!collection.columns.some(([column]) => column === field)) {
				throw new Error(
					`Unknown field "${field}" for collection "${collection.name}"`,
				)
			}
		}
		if (record.id !== id) {
			throw new Error(
				`Record id does not match its key in "${collection.name}"`,
			)
		}
		const values = collection.columns.map(([field, type]) => {
			const encoded = encodeColumn(type, record[field])
			if (encoded instanceof Error) {
				throw new Error(
					`Invalid "${field}" for collection "${collection.name}": ${encoded.message}`,
				)
			}
			return encoded
		})
		const columns = collection.columns.map(([field]) => quoteIdentifier(field))
		const updates = columns
			.filter((column) => column !== `"id"`)
			.map((column) => `${column} = excluded.${column}`)
		return this.db
			.prepare(
				`INSERT INTO ${collection.table} (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})
ON CONFLICT ("id") DO ${updates.length ? `UPDATE SET ${updates.join(", ")}` : "NOTHING"}`,
			)
			.bind(...values)
	}
}
