import {
	AnySchema,
	ClientId,
	CollectionName,
	Cookie,
	EncodedQuery,
	EncodedWhereClause,
	Mutation,
	MutationApi,
	MutationId,
	Patch,
	PatchSetOp,
	RemoteApi,
	ScanWindow,
	untag,
} from "@tandem/types"

type LoggerApi = {
	log: (message: string, ...args: any[]) => void
	error: (message: string, ...args: any[]) => void
	warn: (message: string, ...args: any[]) => void
	info: (message: string, ...args: any[]) => void
	scope: (name: string) => LoggerApi
}

function mutationRemoveOpsToPatch<Schema extends AnySchema>(
	mutation: Mutation<Schema>,
): Patch<Schema> {
	return {
		remove: mutation.ops.flatMap((op) => {
			if (op.type !== "remove") return []
			return [{ collection: op.collection, id: op.id }]
		}),
	}
}

function mutationSetOpsToPatch<Schema extends AnySchema>(
	mutation: Mutation<Schema>,
	collections: Set<CollectionName<Schema>>,
): Patch<Schema> {
	return {
		set: mutation.ops.flatMap((op) => {
			if (op.type !== "set" || !collections.has(op.collection)) return []
			return [{ collection: op.collection, value: op.value }]
		}),
	}
}

function collectSnapshotQueries<Schema extends AnySchema>(
	query: EncodedQuery<Schema>,
): EncodedQuery<Schema>[] {
	return [
		query,
		...Object.values(query.with ?? {}).flatMap(collectSnapshotQueries),
	]
}

function compareValues(
	fieldValue: unknown,
	operator: string,
	comparisonValue: unknown,
): boolean {
	switch (operator) {
		case "=":
			return Object.is(fieldValue, comparisonValue)
		case ">":
			return (fieldValue as any) > (comparisonValue as any)
		case "<":
			return (fieldValue as any) < (comparisonValue as any)
		case ">=":
			return (fieldValue as any) >= (comparisonValue as any)
		case "<=":
			return (fieldValue as any) <= (comparisonValue as any)
		default:
			throw new Error(`Unknown where operator "${operator}"`)
	}
}

function matchesWhere<
	Schema extends AnySchema,
	Collection extends CollectionName<Schema>,
>(
	record: Schema[Collection],
	where: EncodedWhereClause<Schema, Collection>[] | undefined,
): boolean {
	return (where ?? []).every(([field, operator, value]) =>
		compareValues(record[field], operator, value),
	)
}

function mergePatch<Schema extends AnySchema>(
	patches: Patch<Schema>[],
): Patch<Schema> {
	type SetOp = NonNullable<Patch<Schema>["set"]>[number]

	const setMap = new Map<string, SetOp>()
	const removeSet = new Set<string>()

	// Process patches in order to handle overwrites and cancellations
	for (const patch of patches) {
		// Process set operations
		for (const setOp of patch.set ?? []) {
			const key = `${setOp.collection}.${setOp.value.id}`
			// If this entity was marked for removal, unmark it
			removeSet.delete(key)
			// Store the set operation (last write wins for entire entity)
			setMap.set(key, setOp)
		}

		// Process remove operations
		for (const removeOp of patch.remove ?? []) {
			const key = `${removeOp.collection}.${removeOp.id}`
			// Remove set operation for this entity
			setMap.delete(key)
			// Mark entity for removal
			removeSet.add(key)
		}
	}

	// Convert back to arrays
	const set = Array.from(setMap.values())
	const remove = Array.from(removeSet).map((key) => {
		const [collection, id] = key.split(".", 2)
		return {
			collection: collection as CollectionName<Schema>,
			id: id as Schema[CollectionName<Schema>]["id"],
		}
	})

	return { set, remove }
}

type ClientState<Schema extends AnySchema> = {
	poke: () => void
	lastScanWindow: ScanWindow<Schema>
	lastMutationId?: MutationId
}

export class TestRemote<Schema extends AnySchema = AnySchema>
	implements RemoteApi<Schema>
{
	private readonly mutationLog: Mutation<Schema>[] = []
	private readonly clients: Map<ClientId, ClientState<Schema>> = new Map()
	private readonly recordsByCollection = new Map<
		CollectionName<Schema>,
		Map<string | number, Schema[CollectionName<Schema>]>
	>()

	private readonly logger: LoggerApi

	constructor(args: { logger: LoggerApi }) {
		this.logger = args.logger
	}

	pull: RemoteApi<Schema>["pull"] = async ({
		clientId,
		cookie,
		scanWindow,
	}) => {
		this.logger.info(
			`Received pull request from ${clientId} from version ${cookie ?? 0}`,
		)
		const client = this.clients.get(clientId)
		if (!client) {
			throw new Error(`Client ${clientId} not found`)
		}

		// Find the last mutation id for this client
		const lastMutationId = client.lastMutationId
		if (lastMutationId) {
			// We're going to ack this mutation id, so we can forget it
			this.clients.set(clientId, { ...client, lastMutationId: undefined })
		}

		const mutationsSinceCookie = this.mutationLog.slice(
			cookie ? (untag(cookie) as number) : undefined,
		)

		const snapshotQueries = scanWindow.flatMap(collectSnapshotQueries)
		const snapshotCollections = new Set(
			snapshotQueries.map((query) => query.collection),
		)
		const patches = [
			...mutationsSinceCookie.map((mutation) =>
				mutationSetOpsToPatch(mutation, snapshotCollections),
			),
			...mutationsSinceCookie.map(mutationRemoveOpsToPatch),
			this.buildSnapshotPatch(snapshotQueries),
		]
		const patch = mergePatch(patches)

		this.clients.set(clientId, {
			...client,
			lastScanWindow: scanWindow,
		})

		return await Promise.resolve({
			cookie: this.mutationLog.length as Cookie,
			patch,
			lastMutationId,
		})
	}

	push: RemoteApi<Schema>["push"] = async ({ clientId, mutations }) => {
		this.logger.info(`Received ${mutations.length} mutations from ${clientId}`)
		const client = this.clients.get(clientId)
		if (!client) {
			throw new Error(`Client ${clientId} not found`)
		}

		this.mutationLog.push(...mutations)
		for (const mutation of mutations) {
			this.applyMutationToRecords(mutation)
		}

		// Record last mutation id for this client
		const lastMutationId = mutations[mutations.length - 1]!.id
		this.clients.set(clientId, { ...client, lastMutationId })

		this.emitPokesForMutation(mutations)

		await Promise.resolve()
	}

	connect: RemoteApi<Schema>["connect"] = async ({ poke, clientId }) => {
		this.logger.info(`Client connecting: ${clientId}`)
		const state: ClientState<Schema> = {
			poke,
			lastScanWindow: [],
			lastMutationId: undefined,
		}

		this.clients.set(clientId, state)
		return await Promise.resolve(async () => {
			this.logger.info(`Client disconnecting: ${clientId}`)
			await Promise.resolve(() => this.clients.delete(clientId))
		})
	}

	private applyMutationToRecords(mutation: Mutation<Schema>) {
		for (const op of mutation.ops) {
			if (op.type === "set") {
				let collectionRecords = this.recordsByCollection.get(op.collection)
				if (!collectionRecords) {
					collectionRecords = new Map()
					this.recordsByCollection.set(op.collection, collectionRecords)
				}

				collectionRecords.set(op.value.id, op.value)
			} else {
				this.recordsByCollection.get(op.collection)?.delete(op.id)
			}
		}
	}

	private buildSnapshotPatch(snapshotQueries: EncodedQuery<Schema>[]): Patch<Schema> {
		const set: PatchSetOp<Schema>[] = []
		for (const query of snapshotQueries) {
			const collectionRecords = this.recordsByCollection.get(query.collection)
			if (!collectionRecords) continue

			for (const record of collectionRecords.values()) {
				if (!matchesWhere(record, query.where)) continue

				set.push({
					collection: query.collection,
					value: record,
				} as PatchSetOp<Schema>)
			}
		}

		return { set }
	}

	emitPokesForMutation(mutations: Mutation<Schema>[]) {
		this.logger.info("Poking clients")
		for (const client of this.clients.values()) {
			const needsPoke = mutations.some((mutation) =>
				MutationApi.intersectsScanWindow(mutation, client.lastScanWindow),
			)
			if (needsPoke) {
				client.poke()
			}
		}
	}

	// Test helpers
	getMutations() {
		return this.mutationLog
	}

	getClientCount() {
		return this.clients.size
	}
}
