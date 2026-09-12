import type {
	AnySchema,
	ClientId,
	CollectionName,
	Cookie,
	Mutation,
	MutationId,
	MutationOp,
	PatchRemoveOp,
	RelationalQuery,
	RelationalQueryResult,
	RemoteApi,
	ScanWindow,
	AnyRelations,
	RuntimeSchemaDefinition,
} from "@tanishqkancharla/tandem-core"
import { tag, untag } from "@tanishqkancharla/tandem-core"
import {
	executeQueryAsync,
	executeScanWindowAsync,
} from "@tanishqkancharla/tandem-core/internal"
import type { ScanWindowRecord } from "@tanishqkancharla/tandem-core/internal"
import * as errore from "errore"
import {
	AsyncTupleDatabase,
	AsyncTupleDatabaseClient,
	subscribeQueryAsync,
} from "tuple-database"
import type {
	AsyncTupleStorageApi,
	ReadOnlyAsyncTupleDatabaseClientApi,
	WriteOps,
} from "tuple-database"
import { TandemServerError } from "./TandemServerError"
import { TandemServerTransaction } from "./TandemServerTransaction"
import type {
	TandemTuple,
	TandemServerStorageApi,
} from "./storage/TandemServerStorage"

export type TandemServerArgs<
	Schema extends AnySchema,
	Relations extends AnyRelations<Schema>,
> = {
	schema: RuntimeSchemaDefinition<Schema>
	relations: Relations
	storage: TandemServerStorageApi<NoInfer<Schema>>
}

export type TandemServerSubscription<Result> = {
	result: Result
	destroy: () => void
}

export type TandemServerSubscriptionOptions = {
	onError?: (error: Error) => void
}

type SyncedRecordKey<
	Schema extends AnySchema,
	Collection extends CollectionName<Schema> = CollectionName<Schema>,
> = {
	[CurrentCollection in Collection]: {
		collection: CurrentCollection
		id: Schema[CurrentCollection]["id"]
	}
}[Collection]

type SyncClientState<Schema extends AnySchema> = {
	lastMutationId?: MutationId
	poke?: () => void
	scanWindowKey?: string
	syncedRecordKeys?: SyncedRecordKey<Schema>[]
}

type CommitOptions = {
	advanceWithoutWrites?: boolean
	onCommitted?: () => void
	operation: "commit" | "push"
}

function scanWindowRecordToKey<
	Schema extends AnySchema,
	Collection extends CollectionName<Schema>,
>(
	record: ScanWindowRecord<Schema, Collection>,
): SyncedRecordKey<Schema, Collection> {
	return { collection: record.collection, id: record.value.id }
}

function containsRecordKey<Schema extends AnySchema>(
	records: readonly SyncedRecordKey<Schema>[],
	target: SyncedRecordKey<Schema>,
) {
	return records.some(
		(record) =>
			record.collection === target.collection && record.id === target.id,
	)
}

function applyMutationOperation<
	Schema extends AnySchema,
	Relations extends AnyRelations<Schema>,
>(
	transaction: TandemServerTransaction<Schema, Relations>,
	operation: MutationOp<Schema>,
) {
	if (operation.type === "set") {
		transaction.set(operation.collection, operation.value)
		return
	}

	transaction.remove(operation.collection, operation.id)
}

function tandemStorageToTupleDatabaseStorage<Schema extends AnySchema>(
	storage: TandemServerStorageApi<Schema>,
): AsyncTupleStorageApi {
	return {
		scan: (args) => storage.scan(args),
		commit: (writes) => storage.commit(writes as WriteOps<TandemTuple<Schema>>),
		close: () => storage.close(),
	}
}

export class TandemServer<
	Schema extends AnySchema,
	Relations extends AnyRelations<Schema>,
> implements RemoteApi<Schema> {
	private readonly relations: Relations
	private readonly subscriptions = new Set<() => void>()
	private readonly syncClients = new Map<ClientId, SyncClientState<Schema>>()
	private readonly tupleDb: AsyncTupleDatabaseClient<TandemTuple<Schema>>
	private revision = 0

	constructor(args: TandemServerArgs<Schema, Relations>) {
		this.relations = args.relations
		this.tupleDb = new AsyncTupleDatabaseClient<TandemTuple<Schema>>(
			new AsyncTupleDatabase(tandemStorageToTupleDatabaseStorage(args.storage)),
		)
	}

	transact(): TandemServerTransaction<Schema, Relations> {
		return new TandemServerTransaction(this.tupleDb.transact(), this.relations)
	}

	async commit(
		transaction: TandemServerTransaction<Schema, Relations>,
	): Promise<void> {
		const result = await this.commitTransaction(transaction, {
			operation: "commit",
		})
		if (result instanceof Error) throw result
	}

	connect: RemoteApi<Schema>["connect"] = ({ clientId, poke }) => {
		const client = this.getSyncClient(clientId)
		client.poke = poke
		let disconnected = false

		return Promise.resolve(() => {
			if (disconnected) return Promise.resolve()
			disconnected = true

			const current = this.syncClients.get(clientId)
			if (current?.poke === poke) current.poke = undefined
			return Promise.resolve()
		})
	}

	push: RemoteApi<Schema>["push"] = async ({ clientId, mutations }) => {
		const result = await this.applyPush(clientId, mutations)
		if (result instanceof Error) throw result
	}

	pull: RemoteApi<Schema>["pull"] = async (args) => {
		const result = await this.readPull(args)
		if (result instanceof Error) throw result
		return result
	}

	async query<Query extends RelationalQuery<Schema, Relations>>(
		query: Query,
	): Promise<RelationalQueryResult<Schema, Relations, Query>> {
		const result = await this.runQuery(this.tupleDb, query, "query")
		if (result instanceof Error) throw result
		return result
	}

	async subscribe<Query extends RelationalQuery<Schema, Relations>>(
		query: Query,
		callback: (result: RelationalQueryResult<Schema, Relations, Query>) => void,
		options: TandemServerSubscriptionOptions = {},
	): Promise<
		TandemServerSubscription<RelationalQueryResult<Schema, Relations, Query>>
	> {
		const subscription = await subscribeQueryAsync(
			this.tupleDb,
			(db) => this.runQuery(db, query, "subscribe"),
			(result) => {
				if (result instanceof Error) {
					if (options.onError) options.onError(result)
					else console.error(result)
					return
				}
				callback(result)
			},
		).catch((cause) => new TandemServerError({ operation: "subscribe", cause }))

		if (subscription instanceof Error) throw subscription
		if (subscription.result instanceof Error) {
			subscription.destroy()
			throw subscription.result
		}

		let destroyed = false
		const destroy = () => {
			if (destroyed) return
			destroyed = true
			subscription.destroy()
			this.subscriptions.delete(destroy)
		}
		this.subscriptions.add(destroy)

		return { result: subscription.result, destroy }
	}

	async close(): Promise<void> {
		for (const destroy of this.subscriptions) destroy()
		this.syncClients.clear()

		const result = await this.tupleDb
			.close()
			.catch((cause) => new TandemServerError({ operation: "close", cause }))
		if (result instanceof Error) throw result
	}

	private runQuery<Query extends RelationalQuery<Schema, Relations>>(
		db: ReadOnlyAsyncTupleDatabaseClientApi<TandemTuple<Schema>>,
		query: Query,
		operation: "query" | "subscribe",
	): Promise<
		TandemServerError | RelationalQueryResult<Schema, Relations, Query>
	> {
		return executeQueryAsync<Schema, Relations, Query>(
			db,
			this.relations,
			query,
		).catch((cause) => new TandemServerError({ operation, cause }))
	}

	private getSyncClient(clientId: ClientId): SyncClientState<Schema> {
		const current = this.syncClients.get(clientId)
		if (current) return current

		const created: SyncClientState<Schema> = {}
		this.syncClients.set(clientId, created)
		return created
	}

	private applyPush(
		clientId: ClientId,
		mutations: Mutation<Schema>[],
	): Promise<TandemServerError | undefined> {
		if (mutations.length === 0) return Promise.resolve(undefined)

		const transaction = this.transact()
		const staged = errore.try(() => {
			for (const mutation of mutations) {
				for (const operation of mutation.ops) {
					applyMutationOperation(transaction, operation)
				}
			}
		})
		if (staged instanceof Error) {
			return Promise.resolve(
				new TandemServerError({ operation: "push", cause: staged }),
			)
		}

		const lastMutationId = mutations.at(-1)?.id
		return this.commitTransaction(transaction, {
			advanceWithoutWrites: true,
			onCommitted: () => {
				this.getSyncClient(clientId).lastMutationId = lastMutationId
			},
			operation: "push",
		})
	}

	private async readPull(
		args: Parameters<RemoteApi<Schema>["pull"]>[0],
	): Promise<
		TandemServerError | Awaited<ReturnType<RemoteApi<Schema>["pull"]>>
	> {
		const { clientId, cookie, scanWindow } = args
		const client = this.getSyncClient(clientId)
		const scanWindowKey = this.encodeScanWindow(scanWindow)
		if (scanWindowKey instanceof Error) return scanWindowKey

		const revision = this.revision
		const cookieRevision = cookie === undefined ? undefined : untag(cookie)
		const scanWindowChanged = client.scanWindowKey !== scanWindowKey
		const shouldRead =
			client.syncedRecordKeys === undefined ||
			scanWindowChanged ||
			cookieRevision !== revision
		const records = shouldRead
			? await executeScanWindowAsync<Schema, Relations>(
					this.tupleDb,
					this.relations,
					scanWindow,
				).catch((cause) => new TandemServerError({ operation: "pull", cause }))
			: []
		if (records instanceof Error) return records

		const currentRecordKeys = records.map((record) =>
			scanWindowRecordToKey(record),
		)
		const remove: PatchRemoveOp<Schema>[] = shouldRead
			? (client.syncedRecordKeys ?? []).filter(
					(previous) => !containsRecordKey(currentRecordKeys, previous),
				)
			: []
		const lastMutationId = client.lastMutationId

		client.lastMutationId = undefined
		client.scanWindowKey = scanWindowKey
		if (shouldRead) client.syncedRecordKeys = currentRecordKeys

		return {
			cookie: tag<Cookie>(revision),
			patch: { set: records, remove },
			lastMutationId,
		}
	}

	private encodeScanWindow(
		scanWindow: ScanWindow<Schema>,
	): TandemServerError | string {
		const result = errore.try(() => JSON.stringify(scanWindow))
		return result instanceof Error
			? new TandemServerError({ operation: "pull", cause: result })
			: result
	}

	private async commitTransaction(
		transaction: TandemServerTransaction<Schema, Relations>,
		options: CommitOptions,
	): Promise<TandemServerError | undefined> {
		const hasWrites = await transaction
			.commit()
			.catch(
				(cause) =>
					new TandemServerError({ operation: options.operation, cause }),
			)
		if (hasWrites instanceof Error) return hasWrites
		if (!hasWrites && !options.advanceWithoutWrites) return

		options.onCommitted?.()
		this.revision += 1
		this.emitPokes()
	}

	private emitPokes() {
		for (const client of this.syncClients.values()) {
			if (!client.poke) continue

			const result = errore.try(client.poke)
			if (result instanceof Error) {
				console.error(
					new TandemServerError({ operation: "poke", cause: result }),
				)
			}
		}
	}
}
