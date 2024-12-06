import { partition, reverse } from "lodash-es"
import type {
	AsyncTupleStorageApi,
	ReadOnlyTupleDatabaseClientApi,
	Tuple,
	TupleRootTransactionApi,
	WriteOps,
} from "tuple-database"
import {
	InMemoryTupleStorage,
	TupleDatabase,
	TupleDatabaseClient,
	subscribeQuery,
} from "tuple-database"
import type { Assert } from "./typeUtils"

type AnySchema = {
	[collectionName in string]: {
		id: string
	} & Record<string, any>
}

type CollectionName<Schema extends AnySchema> = keyof Schema & string

type SchemaToTupleSchema<Schema extends AnySchema> = {
	[C in CollectionName<Schema>]: {
		key: ["record", collection: C, id: string]
		value: Schema[C]
	}
}[CollectionName<Schema>]

type _TestSchemaToTupleSchema1 = Assert<
	SchemaToTupleSchema<{
		todos: {
			id: string
			text: string
			complete: boolean
		}
	}>,
	{
		key: ["record", "todos", string]
		value: { id: string; text: string; complete: boolean }
	}
>

type RemoteApi = {
	apply(mutation: Mutation): Promise<void>
	receive(handler: (mutation: Mutation) => void): void
}

type DatabaseArgs = {
	storage?: AsyncTupleStorageApi
	remote?: RemoteApi
}

export class Database<Schema extends AnySchema> {
	private readonly tupleDb = new TupleDatabaseClient(
		new TupleDatabase(new InMemoryTupleStorage()),
	)
	/**
	 * Resolves when initial load from storage completes
	 */
	readonly ready: Promise<void>

	private readonly storage?: AsyncTupleStorageApi
	private readonly syncEngine?: SyncEngine

	constructor({ storage, remote }: DatabaseArgs) {
		this.syncEngine = new SyncEngine({
			remote,
			handleRollback: async (mutationsToRollback) => {
				await this.rollback(mutationsToRollback)
			},
			handleReceive: async (mutation) => {
				this.tupleDb.commit(MutationApi.toWriteOps(mutation))
				if (this.storage) {
					await this.storage.commit(MutationApi.toWriteOps(mutation))
				}
			},
		})

		this.ready = storage ? this.loadFromStorage(storage) : Promise.resolve()
	}

	private async rollback(mutationsToRollback: readonly Mutation[]) {
		if (this.storage) {
			try {
				// Rollback storage by applying inverse mutation
				for (const mutation of mutationsToRollback) {
					await this.storage.commit(
						MutationApi.toWriteOps(MutationApi.invertMutation(mutation)),
					)
				}
			} catch (storageError) {
				// If storage rollback fails, log error but continue
				// At this point manual intervention might be needed
				console.error("Failed to rollback storage:", storageError)
			}
		}

		const inverted = reverse(mutationsToRollback)
			.map(MutationApi.invertMutation)
			.map(MutationApi.toWriteOps)

		for (const writeOps of inverted) {
			this.tupleDb.commit(writeOps)
		}
	}

	private async loadFromStorage(storage: AsyncTupleStorageApi) {
		const results = await storage.scan()
		this.tupleDb.commit({ set: results })
	}

	list<Collection extends CollectionName<Schema>>(
		collection: Collection,
	): Schema[Collection][] {
		const results = this.tupleDb.scan({
			gte: ["record", collection, null],
			lte: ["record", collection, true],
		})

		return results.map((result) => result.value)
	}

	get<Collection extends CollectionName<Schema>>(
		collection: Collection,
		id: Schema[Collection]["id"],
	): Schema[Collection] | undefined {
		const tupleSchemaKey: SchemaToTupleSchema<Schema>["key"] = [
			"record",
			collection,
			id,
		]

		const result = this.tupleDb.scan({
			gte: tupleSchemaKey,
			lte: tupleSchemaKey,
		})

		if (result.length === 0) {
			return undefined
		}

		return result[0].value
	}

	subscribe<O>(
		query: (db: LocalReadonlyDatabase<Schema>) => O,
		callback: (result: O) => void,
	): { result: O; destroy: () => void } {
		return subscribeQuery(
			this.tupleDb,
			(db) => query(new LocalReadonlyDatabase(db)),
			callback,
		)
	}

	transact(): LocalTransaction<Schema> {
		const tupleDbTx = this.tupleDb.transact()
		return new LocalTransaction(this, tupleDbTx)
	}

	async commit(mutation: Mutation) {
		// First try to persist to storage
		if (this.storage) {
			await this.storage.commit(MutationApi.toWriteOps(mutation))
		}
		await this.syncEngine?.push(mutation)
	}
}

// class Storage {
// 	constructor(private readonly storageAdapter: AsyncTupleStorageApi) {}

// 	async loadAll(): Promise<KeyValuePair[]> {
// 		const results = await this.storageAdapter.scan()
// 		return results
// 	}

//   sca

// 	async commit(writeOps: WriteOps) {
// 		await this.storageAdapter.commit(writeOps)
// 	}
// }

enum MutationOpType {
	Set,
	Remove,
	// TODO: intent
	// TODO: clear?
}

type SetMutationOp = {
	type: MutationOpType.Set
	key: Tuple
	value: any
	prevValue?: any
}

type RemoveMutationOp = {
	type: MutationOpType.Remove
	key: Tuple
	// We have this here so we can rollback
	value: any
}

type MutationOp = SetMutationOp | RemoveMutationOp

type Mutation = { ops: MutationOp[]; id: string }

namespace MutationApi {
	function invertMutationOp(op: MutationOp): MutationOp {
		switch (op.type) {
			case MutationOpType.Set:
				return "prevValue" in op
					? {
							type: MutationOpType.Set,
							key: op.key,
							value: op.prevValue,
							prevValue: op.value,
						}
					: {
							type: MutationOpType.Remove,
							key: op.key,
							value: op.value,
						}
			case MutationOpType.Remove: {
				return {
					type: MutationOpType.Set,
					key: op.key,
					value: op.value,
				}
			}
			default:
				throw new Error("Unknown mutation op type")
		}
	}

	export function invertMutation(mutation: Mutation): Mutation {
		return {
			ops: mutation.ops.map(invertMutationOp),
			id: `${mutation.id}-reverse`,
		}
	}

	export function toWriteOps(mutation: Mutation): WriteOps {
		const [setOps, removeOps] = partition(
			mutation.ops,
			(op) => op.type === MutationOpType.Set,
		)

		const writeOps = {
			set: setOps.map((op) => ({ key: op.key, value: op.value })),
			remove: removeOps.map((op) => op.key),
		}

		return writeOps
	}
}

class SyncEngine {
	private pendingMutations: Mutation[] = []
	private isRunning = false
	private readonly remote?: RemoteApi
	private readonly handleRollback: (
		mutationsToRollback: readonly Mutation[],
	) => Promise<void>
	private readonly handleReceive: (mutation: Mutation) => void

	constructor(args: {
		remote?: RemoteApi
		handleRollback: (mutationsToRollback: readonly Mutation[]) => Promise<void>
		handleReceive: (mutation: Mutation) => void
	}) {
		this.remote = args.remote
		this.handleRollback = args.handleRollback
		this.handleReceive = args.handleReceive

		// Start listening to remote mutations if remote is provided
		if (this.remote) {
			this.remote.receive((mutation) => {
				this.handleReceive(mutation)
			})
		}
	}

	push(mutation: Mutation) {
		this.pendingMutations.push(mutation)

		this.run().catch((error) => {
			// TODO: Fatal error
			console.error("Error running mutation stream", error)
		})
	}

	private async run() {
		if (this.isRunning) return
		this.isRunning = true

		let nextMutation: Mutation | undefined
		while ((nextMutation = this.pendingMutations.shift())) {
			try {
				// Then apply to remote if available
				if (this.remote) {
					await this.remote.apply(nextMutation)
				}
			} catch (error) {
				console.error("Error applying mutation", error)

				await this.handleRollback([nextMutation, ...this.pendingMutations])
				this.pendingMutations = []
			}
		}

		this.isRunning = false
	}
}

export class LocalReadonlyDatabase<Schema extends AnySchema> {
	constructor(private readonly tupleDb: ReadOnlyTupleDatabaseClientApi) {}

	list<Collection extends CollectionName<Schema>>(
		collection: Collection,
	): Schema[Collection][] {
		const results = this.tupleDb.scan({
			gte: ["record", collection, null],
			lte: ["record", collection, true],
		})

		return results.map((result) => result.value)
	}

	get<Collection extends CollectionName<Schema>>(
		collection: Collection,
		id: Schema[Collection]["id"],
	): Schema[Collection] | undefined {
		const tupleSchemaKey: SchemaToTupleSchema<Schema>["key"] = [
			"record",
			collection,
			id,
		]

		const result = this.tupleDb.scan({
			gte: tupleSchemaKey,
			lte: tupleSchemaKey,
		})

		if (result.length === 0) {
			return undefined
		}

		return result[0].value
	}
}

export class LocalTransaction<Schema extends AnySchema> {
	private readonly ops: MutationOp[] = []

	constructor(
		private readonly db: Database<Schema>,
		private readonly tupleDbTx: TupleRootTransactionApi,
	) {}

	list<Collection extends CollectionName<Schema>>(
		collection: Collection,
	): Readonly<Schema[Collection]>[] {
		const results = this.tupleDbTx.scan({
			gte: ["record", collection, null],
			lte: ["record", collection, true],
		})

		return results.map((result) => result.value)
	}

	get<Collection extends CollectionName<Schema>>(
		collection: Collection,
		id: string,
	): Readonly<Schema[Collection]> | undefined {
		const tupleSchemaKey: SchemaToTupleSchema<Schema>["key"] = [
			"record",
			collection,
			id,
		]

		const result = this.tupleDbTx.scan({
			gte: tupleSchemaKey,
			lte: tupleSchemaKey,
		})

		if (result.length === 0) {
			return undefined
		}

		return result[0].value
	}

	set<Collection extends CollectionName<Schema>>(
		collection: Collection,
		record: Schema[Collection],
	): LocalTransaction<Schema> {
		const tupleSchema: SchemaToTupleSchema<Schema> = {
			key: ["record", collection, record.id],
			value: record,
		}

		const prevValueResult = this.tupleDbTx.scan({
			gte: tupleSchema.key,
			lte: tupleSchema.key,
		})

		this.tupleDbTx.set<any>(tupleSchema.key, tupleSchema.value)

		const setOp: SetMutationOp = {
			type: MutationOpType.Set,
			key: tupleSchema.key,
			value: tupleSchema.value,
		}

		if (prevValueResult.length > 0) {
			setOp.prevValue = prevValueResult[0].value
		}

		this.ops.push(setOp)

		return this
	}

	remove<Collection extends CollectionName<Schema>>(
		collection: Collection,
		id: string,
	): LocalTransaction<Schema> {
		const tupleSchemaKey: SchemaToTupleSchema<Schema>["key"] = [
			"record",
			collection,
			id,
		]

		const values = this.tupleDbTx.scan({
			gte: tupleSchemaKey,
			lte: tupleSchemaKey,
		})

		this.tupleDbTx.remove(tupleSchemaKey)

		if (values.length) {
			this.ops.push({
				type: MutationOpType.Remove,
				key: tupleSchemaKey,
				value: values[0].value,
			})
		}

		return this
	}

	async commit() {
		this.tupleDbTx.commit()
		await this.db.commit({
			// TODO: add intent tag
			ops: this.ops,
			id: this.tupleDbTx.id,
		})
	}

	cancel() {
		this.tupleDbTx.cancel()
	}
}
