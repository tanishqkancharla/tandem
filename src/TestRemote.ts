import { tag, untag } from "../utils/typeUtils"
import { LoggerApi } from "./Logger"
import {
	AnySchema,
	ClientId,
	Mutation,
	MutationApi,
	MutationId,
	RemoteApi,
	ScanWindow,
	WriteOpsApi,
} from "./types"

type ClientState = {
	poke: () => void
	lastScanWindow: ScanWindow
	lastMutationId?: MutationId
}

export class TestRemote<Schema extends AnySchema = AnySchema>
	implements RemoteApi<Schema>
{
	private readonly appliedMutations: Mutation<Schema>[] = []
	private readonly clients: Map<ClientId, ClientState> = new Map()

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
			cookie ? untag(cookie) : undefined,
		)

		const patch = WriteOpsApi.merge(
			...mutationsSinceCookie.map(({ ops }) => MutationApi.toWriteOps(ops)),
		)

		this.clients.set(clientId, {
			...client,
			lastScanWindow: scanWindow,
		})

		return await Promise.resolve({
			cookie: tag(this.appliedMutations.length),
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
		const lastMutationId = mutations[mutations.length - 1].id
		this.clients.set(clientId, { ...client, lastMutationId })

		this.emitPokesForMutation(mutations)

		await Promise.resolve()
	}

	connect: RemoteApi<Schema>["connect"] = async ({ poke, clientId }) => {
		this.logger.info(`Client connecting: ${clientId}`)
		const state: ClientState = {
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
