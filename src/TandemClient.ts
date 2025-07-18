import { Database } from "./Database"
import { q, QueryBuilder, QueryResults } from "./query/Query"
import { SyncEngine } from "./sync/SyncEngine"
import { Transaction } from "./transaction/Transaction"
import {
	AnySchema,
	ClientId,
	CollectionName,
	InvertibleMutation,
	MutationApi,
	Patch,
	PatchApi,
	RemoteApi,
	RngApi,
	StorageApi,
	Thenable,
} from "./types"
import { ConsoleLogger, LoggerApi } from "./utils/Logger"
import { randomId } from "./utils/randomId"
import { tag } from "./utils/typeUtils"

type TandemClientArgs<Schema extends AnySchema> = {
	storage?: StorageApi
	remote?: RemoteApi<Schema>
	logger?: LoggerApi
	rng?: RngApi
	autoConnect?: boolean
	/**
	 * @default 150
	 */
	syncInterval?: number
}

export class TandemClient<Schema extends AnySchema> {
	private readonly db: Database<Schema>
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
		storage: storageAdapter,
		remote,
		logger,
		autoConnect = true,
		syncInterval = 150,
		rng,
	}: TandemClientArgs<Schema>) {
		this.logger = logger ?? new ConsoleLogger(["tandem-client"])

		this.rng = rng ?? { randomId }
		this.clientId = tag(this.rng.randomId())

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
				})
			: undefined

		this.db = new Database({
			logger: this.logger.scope("db"),
			storage: storageAdapter,
			rng: this.rng,
		})

		this.ready = this.db.ready
	}

	pullFromRemote(): Thenable | undefined {
		this.logger.info("Pulling from remote")
		return this.syncEngine?.queuePull()
	}

	private applyPatchAt({
		patch,
		lastMutationId,
	}: {
		patch: Patch<Schema>
		lastMutationId?: string
	}) {
		this.logger.info("Applying patch...")

		if (patch.set?.length === 0 && patch.remove?.length === 0) {
			this.logger.info("No ops to apply")
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
		this.logger.info("Rolling back")
		const inverted = MutationApi.getRollbackWrites(mutationsToRollback)

		const tx = this.db.makeTupleDbTransaction()
		tx.write(inverted)
		tx.commit()
	}

	run<
		Collection extends CollectionName<Schema>,
		Query extends QueryBuilder<Schema, Collection>,
	>(
		collection: Collection,
		queryFn: (q: QueryBuilder<Schema, Collection>) => Query,
	): QueryResults<Query> {
		const query = queryFn(q(collection))
		const result = this.db.run(query)

		return result
	}

	subscribe<
		Collection extends CollectionName<Schema>,
		Query extends QueryBuilder<Schema, Collection>,
	>(
		collection: Collection,
		queryFn: (q: QueryBuilder<Schema, Collection>) => Query,
		// query: Query,
		callback: (result: QueryResults<Query>) => void,
	): { result: QueryResults<Query>; destroy: () => void } {
		const query = queryFn(q(collection))
		const { result, destroy } = this.db.subscribe(query, callback)

		const unsubscribe = this.syncEngine?.subscribe(query.build())

		return {
			result: result,
			destroy: () => {
				unsubscribe?.()
				destroy()
			},
		}
	}

	transact(): Transaction<Schema> {
		return this.db.transact()
	}

	commit(transaction: Transaction<Schema>): Thenable | undefined {
		if (transaction.ops.length === 0) {
			this.logger.info(
				"Attempted to commit transaction with no ops -- bailing.",
			)
			return
		}

		this.logger.info("Committing transaction")
		const mutation: InvertibleMutation<Schema> = {
			ops: transaction.ops,
			id: tag(transaction.tupleDbTx.id),
		}
		this.db.commit(transaction)
		this.speculativeMutations.push(mutation)

		// TODO: return the promise for when it's applied at the remote
		return this.syncEngine?.queuePush(mutation)
	}

	async connect() {
		if (!this.syncEngine) {
			throw new Error("Attempted to connect without a remote server configured")
		}
		return await this.syncEngine.connect()
	}

	async disconnect() {
		if (!this.syncEngine) {
			console.warn("Attempted to disconnect without a remote server configured")
			return
		}
		return await this.syncEngine.disconnect()
	}

	async clear() {
		this.logger.info("Clearing database")

		// Clear speculative mutations
		this.speculativeMutations = []

		// Clear the database
		await this.db.clear()
	}
}
