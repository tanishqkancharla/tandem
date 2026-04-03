import {
	AnySchema,
	ClientId,
	Cookie,
	EncodedQuery,
	InvertibleMutation,
	Mutation,
	MutationId,
	MutationOp,
	Patch,
	PatchApi,
	RemoteApi,
	ScanWindow,
} from "@tandem/types"
import { LoggerApi } from "../utils/Logger"
import { ThrottleQueue } from "../utils/ThrottleQueue"
import { AsyncUnsubscribe, Unsubscribe } from "../utils/typeUtils"

function invertibleMutationToMutation<Schema extends AnySchema>(
	invertible: InvertibleMutation<Schema>,
): Mutation<Schema> {
	return {
		id: invertible.id,
		ops: invertible.ops.map((op): MutationOp<Schema> => {
			if (op.type === "set") {
				return {
					type: "set",
					collection: op.collection,
					value: op.value,
				}
			} else if (op.type === "remove") {
				return {
					type: "remove",
					collection: op.collection,
					id: op.id,
				}
			}
			return op
		}),
	}
}

type SyncEngineArgs<Schema extends AnySchema> = {
	clientId: ClientId
	remote: SyncEngine<Schema>["remote"]
	handleRollback: SyncEngine<Schema>["handleRollback"]
	applyPatchAt: SyncEngine<Schema>["applyPatchAt"]
	autoConnect?: boolean
	syncInterval: number
	logger: SyncEngine<Schema>["logger"]
}

export class SyncEngine<Schema extends AnySchema> {
	private pullQueue: ThrottleQueue
	private pushQueue: ThrottleQueue
	private pendingMutations: InvertibleMutation<Schema>[] = []
	private readonly remote: RemoteApi<Schema>
	private readonly logger: LoggerApi
	private readonly handleRollback: (
		mutationsToRollback: readonly InvertibleMutation<Schema>[],
	) => void
	private readonly applyPatchAt: (args: {
		patch: Patch<Schema>
		lastMutationId?: MutationId
	}) => void

	private readonly clientId: ClientId
	private cookie?: Cookie

	private disconnectFromRemote?: AsyncUnsubscribe
	private scanWindow: ScanWindow<Schema> = []

	constructor(args: SyncEngineArgs<Schema>) {
		this.logger = args.logger
		this.remote = args.remote
		this.handleRollback = args.handleRollback
		this.applyPatchAt = args.applyPatchAt
		this.clientId = args.clientId

		this.pullQueue = new ThrottleQueue(
			() => this.pull(),
			args.syncInterval,
		)

		this.pushQueue = new ThrottleQueue(
			() => this.push(),
			args.syncInterval,
		)

		if (args.autoConnect) {
			this.connect().catch((error) => {
				// TODO: disconnect and operate in offline mode
				this.logger.error("Error connecting to remote", error)
			})
		}
	}

	async connect() {
		this.logger.info("Connecting to remote...")
		const unsubscribe = await this.remote.connect({
			clientId: this.clientId,
			poke: () => {
				this.logger.info("Received poke from remote")
				void this.queuePull().catch((error) => {
					this.logger.error("Error pulling from remote", error)
				})
			},
		})
		this.disconnectFromRemote = unsubscribe

		this.logger.info("Connected to remote")

		await this.queuePull()

		return unsubscribe
	}

	async disconnect() {
		this.logger.info("Disconnecting from remote")
		await this.disconnectFromRemote?.()
		this.disconnectFromRemote = undefined
	}

	subscribe(query: EncodedQuery<Schema>): Unsubscribe {
		this.logger.info("Subscribing to query", query)
		this.scanWindow.push(query)
		void this.queuePull().catch((error) => {
			this.logger.error("Error pulling from remote", error)
		})

		return () => {
			this.logger.info("Unsubscribing from query", query)
			this.scanWindow.splice(this.scanWindow.indexOf(query), 1)
		}
	}

	queuePull(): Promise<void> {
		this.logger.info("Queueing pull...")
		return this.pullQueue.enqueue().then(() => {
			this.logger.info("Pull finished")
		})
	}

	private async pull() {
		if (this.scanWindow.length === 0) return
		this.logger.info("Pulling from remote...")
		const { cookie, patch, lastMutationId } = await this.remote.pull({
			clientId: this.clientId,
			cookie: this.cookie,
			scanWindow: this.scanWindow,
		})

		this.logger.info(
			"Pulled from remote",
			{
				cookie,
				lastMutationId,
			},
			PatchApi.toString(patch),
		)

		this.cookie = cookie

		this.applyPatchAt({ patch, lastMutationId })
	}

	queuePush(mutation: InvertibleMutation<Schema>): Promise<void> {
		this.logger.info("Queueing push...")
		this.pendingMutations.push(mutation)
		return this.pushQueue.enqueue()
	}

	private async push() {
		if (this.pendingMutations.length === 0) return

		const mutations = this.pendingMutations
		this.pendingMutations = []

		try {
			// Convert invertible mutations to regular mutations before pushing
			const serializedMutations = mutations.map(invertibleMutationToMutation)

			// Then apply to remote if available
			await this.remote.push({
				mutations: serializedMutations,
				clientId: this.clientId,
			})
		} catch (error) {
			this.logger.error("Error applying mutation", error)

			this.handleRollback(mutations)
			throw error
		}
	}
}
