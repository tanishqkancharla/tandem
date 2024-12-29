import { WriteOps } from "tuple-database"
import { AsyncUnsubscribe, Unsubscribe } from "../utils/typeUtils"
import { LoggerApi } from "./Logger"
import { ThrottleQueue } from "./ThrottleQueue"
import {
	AnySchema,
	ClientId,
	Cookie,
	EncodedQuery,
	InvertibleMutation,
	MutationId,
	RemoteApi,
	ScanWindow,
	Thenable,
	WriteOpsApi,
} from "./types"

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
		patch: WriteOps
		lastMutationId?: MutationId
	}) => void

	private readonly clientId: ClientId
	private cookie?: Cookie

	private disconnectFromRemote?: AsyncUnsubscribe
	private scanWindow: ScanWindow = []

	constructor(args: SyncEngineArgs<Schema>) {
		this.logger = args.logger
		this.remote = args.remote
		this.handleRollback = args.handleRollback
		this.applyPatchAt = args.applyPatchAt
		this.clientId = args.clientId

		this.pullQueue = new ThrottleQueue(
			() => this.pull(),
			(error) => {
				// TODO: fatal error. This shouldn't happen since pull handles its own errors
				this.logger.error("Error pulling from remote", error)
			},
			args.syncInterval,
		)

		this.pushQueue = new ThrottleQueue(
			() => this.push(),
			(error) => {
				// TODO: fatal error. This shouldn't happen since push handles its own errors
				this.logger.error("Error pushing to remote", error)
			},
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
				this.queuePull()
			},
		})

		this.logger.info("Connected to remote")

		await this.queuePull()

		return unsubscribe
	}

	async disconnect() {
		this.logger.info("Disconnecting from remote")
		await this.disconnectFromRemote?.()
		this.disconnectFromRemote = undefined
	}

	subscribe(query: EncodedQuery): Unsubscribe {
		this.logger.info("Subscribing to query", query)
		this.scanWindow.push(query)
		this.queuePull()

		return () => {
			this.logger.info("Unsubscribing from query", query)
			this.scanWindow.splice(this.scanWindow.indexOf(query), 1)
		}
	}

	queuePull(): Thenable {
		this.logger.info("Queueing pull...")
		return this.pullQueue.enqueue().then(() => {
			this.logger.info("Pull finished")
		})
	}

	private async pull() {
		this.logger.info("Pulling from remote...")
		if (this.scanWindow.length === 0) return
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
			WriteOpsApi.toString(patch),
		)

		this.cookie = cookie

		this.applyPatchAt({ patch, lastMutationId })
	}

	queuePush(mutation: InvertibleMutation<Schema>): Thenable {
		this.logger.info("Queueing push...")
		this.pendingMutations.push(mutation)
		return this.pushQueue.enqueue()
	}

	private async push() {
		if (this.pendingMutations.length === 0) return

		const mutationsToPush = this.pendingMutations
		this.pendingMutations = []

		try {
			// Then apply to remote if available
			await this.remote.push({
				mutations: mutationsToPush,
				clientId: this.clientId,
			})
		} catch (error) {
			console.error("Error applying mutation", error)

			this.handleRollback(mutationsToPush)
		}
	}
}
