import { LoggerApi, untag } from "@tandem/core"
import {
	AnySchema,
	ClientId,
	CollectionName,
	Cookie,
	Mutation,
	MutationApi,
	MutationId,
	MutationOp,
	Patch,
	PatchSetOp,
	RemoteApi,
	ScanWindow,
} from "@tandem/types"

function mutationOpToPatch<Schema extends AnySchema>(
	op: MutationOp<Schema>,
): Patch<Schema> {
	if (op.type === "set") {
		// Direct EV (Entity-Value) conversion
		const set: PatchSetOp<Schema>[] = [
			{
				collection: op.collection,
				value: op.value,
			},
		]
		return { set }
	} else if (op.type === "remove") {
		return {
			remove: [
				{
					collection: op.collection,
					id: op.id,
				},
			],
		}
	}
	throw new Error("Unknown mutation op type")
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
	private readonly appliedMutations: Mutation<Schema>[] = []
	private readonly clients: Map<ClientId, ClientState<Schema>> = new Map()

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

		const mutationsSinceCookie = this.appliedMutations.slice(
			cookie ? (untag(cookie) as number) : undefined,
		)

		const patches = mutationsSinceCookie.flatMap(({ ops }) =>
			ops.map(mutationOpToPatch),
		)
		const patch = mergePatch(patches)

		this.clients.set(clientId, {
			...client,
			lastScanWindow: scanWindow,
		})

		return await Promise.resolve({
			cookie: this.appliedMutations.length as Cookie,
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

		this.appliedMutations.push(...mutations)

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
		return this.appliedMutations
	}

	getClientCount() {
		return this.clients.size
	}
}
