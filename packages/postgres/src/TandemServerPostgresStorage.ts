import crypto from "node:crypto"
import type { AnySchema } from "@tanishqkancharla/tandem-core"
import type {
	TandemServerStorageApi,
	TandemTuple,
} from "@tanishqkancharla/tandem-server"
import { and, asc, desc, gt, gte, inArray, lt, lte, sql } from "drizzle-orm"
import { drizzle } from "drizzle-orm/node-postgres"
import type { NodePgDatabase } from "drizzle-orm/node-postgres"
import * as errore from "errore"
import pg from "pg"
import type { ScanStorageArgs, WriteOps } from "tuple-database"
import {
	decodeTandemPostgresKey,
	encodeTandemPostgresKey,
} from "./TandemPostgresKey.js"
import { tandemPostgresTuples } from "./tandemPostgresTuples.js"

export type TandemServerPostgresStorageArgs =
	| {
			/** The storage opens a pool for this URL and ends it on close. */
			connectionString: string
	  }
	| {
			/**
			 * An app-owned pool, such as a Drizzle database's `$client`. The storage
			 * leaves it open on close. Subscribing holds one of its connections.
			 */
			pool: pg.Pool
	  }

class TandemServerPostgresStorageError extends errore.createTaggedError({
	name: "TandemServerPostgresStorageError",
	message: "Tandem server Postgres storage failed to $operation",
}) {}

// Names Postgres notifications for commits to the tuples table.
const notificationChannel = "tandem_tuples"
// Rows per statement, well under Postgres's 65,535 bind parameter limit.
const batchSize = 1000
const relistenDelayMs = 1000

type Listener = { client: pg.PoolClient | undefined }

/**
 * Stores Tandem server tuples in one Postgres table. Scans read only the
 * requested key range through the table's primary key index.
 */
export class TandemServerPostgresStorage<
	Schema extends AnySchema = AnySchema,
> implements TandemServerStorageApi<Schema> {
	private readonly pool: pg.Pool
	private readonly ownsPool: boolean
	private readonly db: NodePgDatabase
	// Tags this storage's notifications so it can skip its own.
	private readonly instanceId = crypto.randomUUID()
	private readonly subscribers = new Set<() => void>()
	private listener: Listener | undefined
	private relistenTimer: ReturnType<typeof setTimeout> | undefined
	private closed = false

	constructor(args: TandemServerPostgresStorageArgs) {
		this.ownsPool = "connectionString" in args
		this.pool =
			"pool" in args ? args.pool : this.createPool(args.connectionString)
		this.db = drizzle({ client: this.pool })
	}

	async scan(args: ScanStorageArgs = {}): Promise<TandemTuple<Schema>[]> {
		const rows = await this.readRange(args)
		if (rows instanceof Error) throw rows
		return rows
	}

	async commit(writes: WriteOps<TandemTuple<Schema>>): Promise<void> {
		const result = await this.write(writes)
		if (result instanceof Error) throw result
	}

	/**
	 * Calls onChange after another storage instance commits to the same
	 * database, and after each time this storage starts listening, since it
	 * cannot see commits made while it was not.
	 */
	subscribe(onChange: () => void): () => void {
		this.subscribers.add(onChange)
		this.listen()
		return () => {
			this.subscribers.delete(onChange)
			if (this.subscribers.size === 0) void this.stopListening()
		}
	}

	async close(): Promise<void> {
		if (this.closed) return
		this.closed = true
		this.subscribers.clear()
		await this.stopListening()
		if (!this.ownsPool) return

		const ended = await this.pool
			.end()
			.catch(
				(cause) =>
					new TandemServerPostgresStorageError({ operation: "close", cause }),
			)
		if (ended instanceof Error) throw ended
	}

	private createPool(connectionString: string) {
		const pool = new pg.Pool({ connectionString })
		// Postgres can end idle connections, for example on restart. Without a
		// listener, the pool's error event would crash the process.
		pool.on("error", (cause) => {
			console.warn(
				new TandemServerPostgresStorageError({
					operation: "keep an idle connection",
					cause,
				}),
			)
		})
		return pool
	}

	private async readRange(args: ScanStorageArgs) {
		// Like tuple-database, gte wins over gt and lte over lt.
		const start = args.gte ?? args.gt
		const end = args.lte ?? args.lt
		const startKey = start && encodeTandemPostgresKey(start)
		const endKey = end && encodeTandemPostgresKey(end)
		if (startKey && endKey && Buffer.compare(startKey, endKey) > 0) {
			return new TandemServerPostgresStorageError({
				operation: "scan",
				cause: new Error("Invalid bounds: the start is after the end."),
			})
		}

		const { key } = tandemPostgresTuples
		const query = this.db
			.select()
			.from(tandemPostgresTuples)
			.where(
				and(
					startKey && (args.gte ? gte(key, startKey) : gt(key, startKey)),
					endKey && (args.lte ? lte(key, endKey) : lt(key, endKey)),
				),
			)
			.orderBy(args.reverse ? desc(key) : asc(key))
			.$dynamic()
		// tuple-database treats a limit of 0 as no limit.
		const rows = await (args.limit ? query.limit(args.limit) : query).catch(
			(cause) =>
				new TandemServerPostgresStorageError({ operation: "scan", cause }),
		)
		if (rows instanceof Error) return rows

		return rows.map(
			(row) =>
				({
					key: decodeTandemPostgresKey(row.key),
					value: row.value,
				}) as TandemTuple<Schema>,
		)
	}

	private write(writes: WriteOps<TandemTuple<Schema>>) {
		// Like tuple-database, a key both set and removed ends up set, and the
		// last set of a key wins.
		const sets = new Map<string, { key: Uint8Array; value: unknown }>()
		for (const { key, value } of writes.set ?? []) {
			const encoded = encodeTandemPostgresKey(key)
			sets.set(Buffer.from(encoded).toString("hex"), { key: encoded, value })
		}
		const removes = new Map<string, Uint8Array>()
		for (const key of writes.remove ?? []) {
			const encoded = encodeTandemPostgresKey(key)
			const id = Buffer.from(encoded).toString("hex")
			if (!sets.has(id)) removes.set(id, encoded)
		}
		if (sets.size === 0 && removes.size === 0) return

		// Each statement locks rows in key order, which keeps concurrent commits
		// from several servers from deadlocking on the same rows in most cases.
		// Postgres aborts one side of any deadlock left, and that commit rejects.
		const removeKeys = [...removes.values()].toSorted((a, b) =>
			Buffer.compare(a, b),
		)
		const setRows = [...sets.values()].toSorted((a, b) =>
			Buffer.compare(a.key, b.key),
		)
		const { key } = tandemPostgresTuples
		return this.db
			.transaction(async (tx) => {
				for (const batch of chunk(removeKeys)) {
					await tx.delete(tandemPostgresTuples).where(inArray(key, batch))
				}
				for (const batch of chunk(setRows)) {
					await tx
						.insert(tandemPostgresTuples)
						.values(batch)
						.onConflictDoUpdate({
							target: key,
							set: { value: sql`excluded.value` },
						})
				}
				// Postgres delivers notifications only once the transaction commits.
				await tx.execute(
					sql`select pg_notify(${notificationChannel}, ${this.instanceId})`,
				)
			})
			.catch(
				(cause) =>
					new TandemServerPostgresStorageError({ operation: "commit", cause }),
			)
	}

	private listen() {
		if (this.closed || this.listener || this.subscribers.size === 0) return
		const listener: Listener = { client: undefined }
		this.listener = listener
		void this.connectListener(listener)
	}

	private async connectListener(listener: Listener) {
		const client = await this.pool.connect().catch(
			(cause) =>
				new TandemServerPostgresStorageError({
					operation: "listen for changes",
					cause,
				}),
		)
		if (client instanceof Error) return this.relisten(listener, client)
		if (this.listener !== listener) return client.release(true)

		listener.client = client
		client.on("notification", (message) => {
			if (this.listener !== listener) return
			if (message.payload === this.instanceId) return
			this.notifySubscribers()
		})
		client.on("error", (cause) => {
			this.relisten(
				listener,
				new TandemServerPostgresStorageError({
					operation: "listen for changes",
					cause,
				}),
			)
		})
		const listening = await client.query(`LISTEN ${notificationChannel}`).catch(
			(cause) =>
				new TandemServerPostgresStorageError({
					operation: "listen for changes",
					cause,
				}),
		)
		if (listening instanceof Error) return this.relisten(listener, listening)
		if (this.listener !== listener) return

		this.notifySubscribers()
	}

	private relisten(
		listener: Listener,
		error: TandemServerPostgresStorageError,
	) {
		if (this.listener !== listener) return
		console.warn(error)
		void this.stopListening()
		this.relistenTimer = setTimeout(() => {
			this.relistenTimer = undefined
			this.listen()
		}, relistenDelayMs)
	}

	private stopListening() {
		clearTimeout(this.relistenTimer)
		this.relistenTimer = undefined
		const client = this.listener?.client
		this.listener = undefined
		if (!client) return Promise.resolve()

		// Close the connection rather than return a listening one to the pool.
		const ended = new Promise<void>((resolve) => client.once("end", resolve))
		client.release(true)
		return ended
	}

	private notifySubscribers() {
		for (const onChange of this.subscribers) onChange()
	}
}

function chunk<T>(items: T[]) {
	const batches: T[][] = []
	for (let start = 0; start < items.length; start += batchSize) {
		batches.push(items.slice(start, start + batchSize))
	}
	return batches
}
