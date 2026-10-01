import type { Database } from "../Database.js"
import type { EncodedQuery, ScanWindow } from "../query/Query.js"
import type { AnySchema, CollectionName } from "../schema/Schema.js"
import type {
	Mutation,
	MutationId,
	Transaction,
} from "../transaction/Transaction.js"
import type { LoggerApi } from "../utils/Logger.js"
import { TaskQueue } from "../utils/TaskQueue.js"
import { Timer, type TimerApi } from "../utils/Timer.js"
import { tag } from "../utils/typeUtils.js"
import { PendingWrites } from "./PendingWrites.js"
import type {
	AsyncUnsubscribe,
	Tagged,
	Unsubscribe,
} from "../utils/typeUtils.js"

export type ClientId = Tagged<"ClientId", string>
export type Cookie = Tagged<"Cookie", number | string>

export type ClientApi = {
	clientId: ClientId
	/** Settles when the pull the poke started has finished. Never rejects. */
	poke: () => Promise<void>
}

export type RemoteApi<Schema extends AnySchema> = {
	connect(api: ClientApi): Promise<AsyncUnsubscribe>
	push(args: {
		mutations: Mutation<Schema>[]
		clientId: ClientId
	}): Promise<void>
	pull(args: {
		clientId: ClientId
		cookie?: Cookie
		scanWindow: ScanWindow<Schema>
	}): Promise<{
		cookie: Cookie
		patch: Patch<Schema>
		/**
		 * The last of this client's mutations the server applied, on every pull.
		 * 0 before the server has applied any.
		 */
		lastMutationId: MutationId
	}>
}

export type PatchSetOp<Schema extends AnySchema> = {
	[Collection in CollectionName<Schema>]: {
		collection: Collection
		value: Schema[Collection]
	}
}[CollectionName<Schema>]

export type PatchRemoveOp<Schema extends AnySchema> = {
	[Collection in CollectionName<Schema>]: {
		collection: Collection
		id: Schema[Collection]["id"]
	}
}[CollectionName<Schema>]

export type Patch<Schema extends AnySchema = AnySchema> = {
	set?: PatchSetOp<Schema>[]
	remove?: PatchRemoveOp<Schema>[]
}

export namespace PatchApi {
	export function toString<Schema extends AnySchema>(
		patch: Patch<Schema>,
	): string {
		return `Patch {\n${
			patch.set
				?.map(
					(op) =>
						`  set ${op.collection}.${op.value.id} = ${JSON.stringify(op.value)}`,
				)
				.join("\n") ?? ""
		}\n${patch.remove?.map((op) => `  remove ${op.collection}.${op.id}`).join("\n") ?? ""}}`
	}
}

export type SyncEngineArgs<Schema extends AnySchema> = {
	clientId: ClientId
	remote: SyncEngine<Schema>["remote"]
	db: SyncEngine<Schema>["db"]
	autoConnect?: boolean
	logger: SyncEngine<Schema>["logger"]
	syncInterval: number | TimerApi
}

export class SyncEngine<Schema extends AnySchema> {
	private syncQueue: TaskQueue<"pull" | "push">
	private pendingMutations: Mutation<Schema>[] = []
	private readonly pendingWrites = new PendingWrites<Schema>()
	// Keep IDs monotonic for this client identity, including across clear().
	private mutationCount = 0
	private readonly db: Pick<
		Database<Schema>,
		"get" | "commit" | "makeTupleDbTransaction" | "clear"
	>
	private readonly remote: RemoteApi<Schema>
	private readonly logger: LoggerApi

	private readonly clientId: ClientId
	private cookie?: Cookie

	private disconnectFromRemote?: AsyncUnsubscribe
	private scanWindow: ScanWindow<Schema> = []

	constructor(args: SyncEngineArgs<Schema>) {
		this.logger = args.logger
		this.remote = args.remote
		this.db = args.db
		this.clientId = args.clientId
		const timer =
			typeof args.syncInterval === "number"
				? new Timer({ interval: args.syncInterval })
				: args.syncInterval

		this.syncQueue = new TaskQueue(
			{
				pull: () => this.pull(),
				push: () => this.push(),
			},
			timer,
		)

		if (args.autoConnect) {
			this.connect().catch((error) => {
				// TODO: disconnect and operate in offline mode
				this.logger.error({ message: "error connecting to remote", error })
			})
		}
	}

	async connect(): Promise<AsyncUnsubscribe> {
		this.logger.info({ message: "connecting to remote" })
		const unsubscribe = await this.remote.connect({
			clientId: this.clientId,
			poke: () => {
				this.logger.info({ message: "received poke from remote" })
				return this.queuePull().catch((error) => {
					this.logger.error({ message: "error pulling from remote", error })
				})
			},
		})
		this.disconnectFromRemote = unsubscribe

		this.logger.info({ message: "connected to remote" })

		await this.queuePull()
		if (this.pendingMutations.length > 0) {
			await this.syncQueue.enqueue("push")
		}

		return unsubscribe
	}

	async disconnect() {
		this.logger.info({ message: "disconnecting from remote" })
		await this.disconnectFromRemote?.()
		this.disconnectFromRemote = undefined
	}

	subscribe(query: EncodedQuery<Schema>): Unsubscribe {
		this.logger.info({ message: "subscribing to query", query })
		this.scanWindow.push(query)
		void this.queuePull().catch((error) => {
			this.logger.error({ message: "error pulling from remote", error })
		})

		return () => {
			this.logger.info({ message: "unsubscribing from query", query })
			this.scanWindow.splice(this.scanWindow.indexOf(query), 1)
		}
	}

	queuePull(): Promise<void> {
		this.logger.info({ message: "queueing pull" })
		return this.syncQueue.enqueue("pull").then(() => {
			this.logger.info({ message: "pull finished" })
		})
	}

	private async pull() {
		if (!this.disconnectFromRemote) {
			return
		}

		this.logger.info({ message: "pulling from remote" })
		const { cookie, patch, lastMutationId } = await this.remote.pull({
			clientId: this.clientId,
			cookie: this.cookie,
			scanWindow: this.scanWindow,
		})

		this.logger.info({
			message: "pulled from remote",
			cookie,
			lastMutationId,
			patch: PatchApi.toString(patch),
		})

		this.cookie = cookie

		const tx = this.db.makeTupleDbTransaction()
		this.pendingWrites.applyPull(tx, { patch, lastMutationId })
		tx.commit()
	}

	commit(transaction: Transaction<Schema>): Promise<void> {
		const mutation: Mutation<Schema> = {
			ops: transaction.ops,
			id: tag<MutationId>(this.mutationCount + 1),
		}
		this.pendingWrites.commitAndTrack(mutation, {
			readCommittedRecord: ({ collection, id }) => this.db.get(collection, id),
			commit: () => this.db.commit(transaction),
		})
		this.mutationCount += 1
		this.logger.info({ message: "queueing push" })
		this.pendingMutations.push(mutation)
		return this.syncQueue.enqueue("push")
	}

	private async push() {
		if (this.pendingMutations.length === 0) return

		if (!this.disconnectFromRemote) {
			this.logger.info({ message: "skipping push while disconnected" })
			return
		}

		const mutations = this.pendingMutations
		this.pendingMutations = []

		try {
			await this.remote.push({ mutations, clientId: this.clientId })
		} catch (error) {
			this.logger.error({ message: "error applying mutation", error })

			const tx = this.db.makeTupleDbTransaction()
			this.pendingWrites.rollBackRejected(tx, mutations)
			tx.commit()
			throw error
		}
	}

	async clear() {
		this.pendingWrites.clearAll()
		await this.db.clear()
	}
}
