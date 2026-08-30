import type {
	AnySchema,
	ClientId,
	CollectionName,
	Cookie,
	EncodedQuery,
	Mutation,
	MutationId,
	Patch,
	RemoteApi,
	ScanWindow,
} from "@tanishqkancharla/tandem-core"
import { MutationApi, untag } from "@tanishqkancharla/tandem-core"

type ClientState<Schema extends AnySchema> = {
	poke: () => void
	lastScanWindow: ScanWindow<Schema>
	lastMutationId?: MutationId
}

export type RemoteStore<Schema extends AnySchema> = {
	applyMutations(mutations: Mutation<Schema>[]): Promise<void>
	readSnapshot(queries: EncodedQuery<Schema>[]): Promise<Patch<Schema>>
}

export type RemoteServerArgs<Schema extends AnySchema> = {
	store: RemoteStore<Schema>
}

function collectSnapshotQueries<Schema extends AnySchema>(
	query: EncodedQuery<Schema>,
): EncodedQuery<Schema>[] {
	return [
		query,
		...Object.values(query.with ?? {}).flatMap(collectSnapshotQueries),
	]
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

function mergePatch<Schema extends AnySchema>(
	patches: Patch<Schema>[],
): Patch<Schema> {
	type SetOp = NonNullable<Patch<Schema>["set"]>[number]
	type RemoveOp = NonNullable<Patch<Schema>["remove"]>[number]

	const setMap = new Map<string, SetOp>()
	const removeMap = new Map<string, RemoveOp>()

	for (const patch of patches) {
		for (const setOp of patch.set ?? []) {
			const key = `${setOp.collection}.${setOp.value.id}`
			removeMap.delete(key)
			setMap.set(key, setOp)
		}

		for (const removeOp of patch.remove ?? []) {
			const key = `${removeOp.collection}.${removeOp.id}`
			setMap.delete(key)
			removeMap.set(key, removeOp)
		}
	}

	return {
		set: Array.from(setMap.values()),
		remove: Array.from(removeMap.values()),
	}
}

export class RemoteServer<
	Schema extends AnySchema = AnySchema,
> implements RemoteApi<Schema> {
	private readonly clients = new Map<ClientId, ClientState<Schema>>()
	private readonly mutationLog: Mutation<Schema>[] = []
	private readonly store: RemoteStore<Schema>

	constructor(args: RemoteServerArgs<Schema>) {
		this.store = args.store
	}

	connect: RemoteApi<Schema>["connect"] = ({ poke, clientId }) => {
		this.clients.set(clientId, {
			poke,
			lastScanWindow: [],
			lastMutationId: undefined,
		})

		return Promise.resolve(() => {
			this.clients.delete(clientId)
			return Promise.resolve()
		})
	}

	push: RemoteApi<Schema>["push"] = async ({ clientId, mutations }) => {
		const client = this.getClient(clientId)
		await this.store.applyMutations(mutations)

		this.mutationLog.push(...mutations)
		const lastMutationId = mutations[mutations.length - 1]?.id
		this.clients.set(clientId, { ...client, lastMutationId })
		this.emitPokesForMutations(mutations)
	}

	pull: RemoteApi<Schema>["pull"] = async ({
		clientId,
		cookie,
		scanWindow,
	}) => {
		const client = this.getClient(clientId)
		const lastMutationId = client.lastMutationId
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
			await this.store.readSnapshot(snapshotQueries),
		]

		this.clients.set(clientId, {
			...client,
			lastScanWindow: scanWindow,
			lastMutationId: undefined,
		})

		return {
			cookie: this.mutationLog.length as Cookie,
			patch: mergePatch(patches),
			lastMutationId,
		}
	}

	destroy(): Promise<void> {
		this.clients.clear()
		return Promise.resolve()
	}

	private getClient(clientId: ClientId): ClientState<Schema> {
		const client = this.clients.get(clientId)
		if (!client) {
			throw new Error(`Client ${clientId} not found`)
		}

		return client
	}

	private emitPokesForMutations(mutations: Mutation<Schema>[]) {
		for (const client of this.clients.values()) {
			const needsPoke = mutations.some((mutation) =>
				MutationApi.intersectsScanWindow(mutation, client.lastScanWindow),
			)
			if (needsPoke) {
				client.poke()
			}
		}
	}
}
