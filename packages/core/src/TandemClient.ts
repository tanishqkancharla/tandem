import { Database } from "./Database"
import { _encodeRelationalQuery } from "./query/Query"
import { SyncEngine } from "./sync/SyncEngine"
import { Transaction } from "./transaction/Transaction"
import {
	AnySchema,
	ClientId,
	InvertibleMutation,
	MutationApi,
	MutationId,
	Patch,
	PatchApi,
	RemoteApi,
	RelationalQuery,
	RelationalQueryResult,
	RngApi,
	RuntimeRelationsDefinition,
	RuntimeSchemaDefinition,
	StorageApi,
	type TimerApi,
} from "@tandem/types"
import { ConsoleLoggerSink, Logger, type LoggerApi } from "./utils/Logger"
import { randomId } from "./utils/randomId"
import { Timer } from "./utils/Timer"

type TandemClientArgs<
	Schema extends AnySchema,
	Relations extends RuntimeRelationsDefinition<Schema>,
> = {
	schema?: RuntimeSchemaDefinition<Schema>
	relations?: Relations
	storage?: StorageApi
	remote?: RemoteApi<Schema>
	logger?: LoggerApi
	rng?: RngApi
	timer?: TimerApi
	autoConnect?: boolean
	/**
	 * @default 150
	 */
	syncInterval?: number
}

export class TandemClient<
	Schema extends AnySchema,
	Relations extends RuntimeRelationsDefinition<Schema> =
		RuntimeRelationsDefinition<Schema>,
> {
	private readonly db: Database<Schema, Relations>
	/**
	 * Resolves when initial load from storage completes
	 */
	readonly ready: Promise<void>

	// TODO: use a real uuid
	readonly clientId: ClientId

	private readonly syncEngine?: SyncEngine<Schema>
	private readonly logger: LoggerApi
	private readonly rng: RngApi

	private speculativeMutations: InvertibleMutation<Schema>[] = []
	constructor({
		schema,
		relations,
		storage: storageAdapter,
		remote,
		logger,
		autoConnect = true,
		syncInterval = 150,
		rng,
		timer,
	}: TandemClientArgs<Schema, Relations>) {
		this.rng = rng ?? { randomId }
		this.clientId = this.rng.randomId() as ClientId
		this.logger = logger ?? new Logger({ sinks: new ConsoleLoggerSink() })

		const timerImpl = timer ?? new Timer()

		this.syncEngine = remote
			? new SyncEngine({
					remote,
					clientId: this.clientId,
					handleRollback: (mutationsToRollback) => {
						this.rollback(mutationsToRollback)
					},
					applyPatchAt: (args) => this.applyPatchAt(args),
					autoConnect,
					logger: this.logger.scope("sync-engine"),
					syncInterval,
					timer: timerImpl,
				})
			: undefined

		this.db = new Database({
			schema,
			relations,
			logger: this.logger.scope("db"),
			storage: storageAdapter,
			rng: this.rng,
		})

		this.ready = this.db.ready
	}

	pullFromRemote(): Promise<void> {
		if (!this.syncEngine) {
			return Promise.resolve()
		}

		this.logger.info({ message: "pulling from remote" })
		return this.syncEngine.queuePull()
	}

	private applyPatchAt({
		patch,
		lastMutationId,
	}: {
		patch: Patch<Schema>
		lastMutationId?: MutationId
	}) {
		this.logger.info({ message: "applying patch" })

		if (patch.set?.length === 0 && patch.remove?.length === 0) {
			this.logger.info({ message: "no ops to apply" })
			return
		}

		// A little magick-y but this works as expected even when lastMutationId is
		// undefined because this will be -1, and we'll report all speculative mutations
		// as still speculative
		const commitedMutationIndex = this.speculativeMutations.findIndex(
			(m) => m.id === lastMutationId,
		)

		const tx = this.db.makeTupleDbTransaction()

		// Rollback to before all the speculative mutations
		const inverted = MutationApi.getRollbackWrites(this.speculativeMutations)
		tx.write(inverted)

		// Convert patch to WriteOps and apply
		const writeOps = PatchApi.toWriteOps(patch)
		tx.write(writeOps)

		// Apply the un-committed still speculative mutations on top
		const stillSpeculative = this.speculativeMutations.slice(
			commitedMutationIndex + 1,
		)

		for (const mutation of stillSpeculative) {
			tx.write(MutationApi.toWriteOps(mutation.ops))
		}

		tx.commit()

		this.speculativeMutations = stillSpeculative
	}

	private rollback(mutationsToRollback: readonly InvertibleMutation<Schema>[]) {
		this.logger.info({ message: "rolling back" })
		const inverted = MutationApi.getRollbackWrites(mutationsToRollback)

		const tx = this.db.makeTupleDbTransaction()
		tx.write(inverted)
		tx.commit()
	}

	query<Query extends RelationalQuery<Schema, Relations>>(
		query: Query,
	): RelationalQueryResult<Schema, Relations, Query> {
		return this.db.query(query)
	}

	subscribe<Query extends RelationalQuery<Schema, Relations>>(
		query: Query,
		callback: (result: RelationalQueryResult<Schema, Relations, Query>) => void,
	): {
		result: RelationalQueryResult<Schema, Relations, Query>
		destroy: () => void
	} {
		const { result, destroy } = this.db.subscribe(query, callback)
		const unsubscribe = this.syncEngine?.subscribe(
			_encodeRelationalQuery(query.collection, query, this.db.relations),
		)

		return {
			result,
			destroy: () => {
				unsubscribe?.()
				destroy()
			},
		}
	}

	transact(): Transaction<Schema> {
		return this.db.transact()
	}

	commit(transaction: Transaction<Schema>): Promise<void> {
		if (transaction.ops.length === 0) {
			this.logger.info({
				message: "attempted to commit transaction with no ops",
			})
			return Promise.resolve()
		}

		this.logger.info({ message: "committing transaction" })
		const mutation: InvertibleMutation<Schema> = {
			ops: transaction.ops,
			id: transaction.tupleDbTx.id as MutationId,
		}
		this.db.commit(transaction)
		this.speculativeMutations.push(mutation)

		const commitPromise =
			this.syncEngine?.queuePush(mutation) ?? Promise.resolve()

		// Ignored commit promises should not surface unhandled rejections.
		commitPromise.catch(() => {})

		return commitPromise
	}

	async connect() {
		if (!this.syncEngine) {
			throw new Error("Attempted to connect without a remote server configured")
		}
		return await this.syncEngine.connect()
	}

	async disconnect() {
		if (!this.syncEngine) {
			this.logger.warn({
				message: "attempted to disconnect without a remote server configured",
			})
			return
		}
		return await this.syncEngine.disconnect()
	}

	/**
	 * Flush any pending writes to storage immediately.
	 */
	async flushStorage(): Promise<void> {
		await this.db.flushStorage()
	}

	async clear() {
		this.logger.info({ message: "clearing database" })

		// Clear speculative mutations
		this.speculativeMutations = []

		// Clear the database
		await this.db.clear()
	}
}
