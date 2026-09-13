import type { WriteOps } from "tuple-database"
import type { EncodedQuery, ScanWindow } from "../query/Query"
import type {
	AnySchema,
	CollectionName,
	SchemaToTupleSchema,
} from "../schema/Schema"
import type {
	InvertibleMutation,
	Mutation,
	MutationId,
	MutationOp,
} from "../transaction/Transaction"
import type { LoggerApi } from "../utils/Logger.js"
import { TaskQueue } from "../utils/TaskQueue.js"
import type { TimerApi } from "../utils/Timer"
import type {
	AsyncUnsubscribe,
	Tagged,
	Unsubscribe,
} from "../utils/typeUtils.js"

export type ClientId = Tagged<"ClientId", string>
export type Cookie = Tagged<"Cookie", number | string>

export type ClientApi = {
	clientId: ClientId
	poke: () => void
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
		lastMutationId?: MutationId
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

	export function toWriteOps<Schema extends AnySchema>(
		patch: Patch<Schema>,
	): WriteOps<SchemaToTupleSchema<Schema>> {
		const set: SchemaToTupleSchema<Schema>[] = []
		const remove: SchemaToTupleSchema<Schema>["key"][] = []

		for (const s of patch.set ?? []) {
			const key = ["record", s.collection, s.value.id]
			set.push({ key, value: s.value } as SchemaToTupleSchema<Schema>)
		}

		for (const r of patch.remove ?? []) {
			remove.push(["record", r.collection, r.id])
		}

		return { set, remove }
	}
}

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

export type SyncEngineArgs<Schema extends AnySchema> = {
	clientId: ClientId
	remote: SyncEngine<Schema>["remote"]
	handleRollback: SyncEngine<Schema>["handleRollback"]
	applyPatchAt: SyncEngine<Schema>["applyPatchAt"]
	autoConnect?: boolean
	syncInterval: number
	logger: SyncEngine<Schema>["logger"]
	timer: TimerApi
}

export class SyncEngine<Schema extends AnySchema> {
	private syncQueue: TaskQueue<"pull" | "push">
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

		this.syncQueue = new TaskQueue(
			{
				pull: () => this.pull(),
				push: () => this.push(),
			},
			args.syncInterval,
			args.timer,
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
				void this.queuePull().catch((error) => {
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

		this.applyPatchAt({ patch, lastMutationId })
	}

	queuePush(mutation: InvertibleMutation<Schema>): Promise<void> {
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
			// Convert invertible mutations to regular mutations before pushing
			const serializedMutations = mutations.map(invertibleMutationToMutation)

			// Then apply to remote if available
			await this.remote.push({
				mutations: serializedMutations,
				clientId: this.clientId,
			})
		} catch (error) {
			this.logger.error({ message: "error applying mutation", error })

			this.handleRollback(mutations)
			throw error
		}
	}
}
