import type {
	AnySchema,
	RelationalQuery,
	RelationalQueryResult,
	AnyRelations,
	RuntimeSchemaDefinition,
} from "@tanishqkancharla/tandem-core"
import { executeQueryAsync } from "@tanishqkancharla/tandem-core/internal"
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
> {
	private readonly relations: Relations
	private readonly subscriptions = new Set<() => void>()
	private readonly tupleDb: AsyncTupleDatabaseClient<TandemTuple<Schema>>

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
		const result = await transaction
			.commit()
			.catch((cause) => new TandemServerError({ operation: "commit", cause }))
		if (result instanceof Error) throw result
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
}
