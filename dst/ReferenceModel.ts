import type { Mutation, RemoteApi } from "@tanishqkancharla/tandem-core"
import type { DstSchema, DstTodo } from "./DstWorld.js"

export type DstOp =
	| { type: "set"; item: DstTodo }
	| { type: "remove"; id: string }

export type DstWrite = { mutationId: string; op: DstOp }

type PullArgs = Parameters<RemoteApi<DstSchema>["pull"]>[0]
type PullResponse = Awaited<ReturnType<RemoteApi<DstSchema>["pull"]>>

function byId(a: DstTodo, b: DstTodo): number {
	return a.id.localeCompare(b.id)
}

function apply(state: Map<string, DstTodo>, op: DstOp): void {
	if (op.type === "set") state.set(op.item.id, op.item)
	else state.delete(op.id)
}

/**
 * What the server and each client should hold, built from what the run
 * observes rather than from Tandem's internals.
 *
 * A client should show the last server state it received plus its own
 * unacknowledged writes, replayed in order. A write leaves the pending list
 * only when a pull acknowledges it; a push that fails in transit does not
 * discard it, because the write must still reach the server.
 */
export class ReferenceModel<Client extends string> {
	private readonly server = new Map<string, DstTodo>()
	private readonly pending = new Map<Client, DstWrite[]>()
	private readonly received = new Map<Client, Map<string, DstTodo>>()

	wrote(client: Client, write: DstWrite): void {
		this.pending.set(client, [...(this.pending.get(client) ?? []), write])
	}

	/** The server committed these mutations. */
	accepted(mutations: readonly Mutation<DstSchema>[]): void {
		for (const { ops } of mutations) {
			for (const op of ops) {
				if (op.collection !== "todos") continue
				apply(
					this.server,
					op.type === "set"
						? { type: "set", item: op.value }
						: { type: "remove", id: String(op.id) },
				)
			}
		}
	}

	/** A pull response reached the client. */
	pulled(client: Client, args: PullArgs, response: PullResponse): void {
		// The server re-reads the window, and sends all of it, whenever the
		// client's cookie is stale. Otherwise the response changes nothing.
		if (args.cookie === undefined || response.cookie !== args.cookie) {
			this.received.set(
				client,
				new Map(
					(response.patch.set ?? [])
						.filter((record) => record.collection === "todos")
						.map(({ value }) => [value.id, value]),
				),
			)
		}
		if (response.lastMutationId === undefined) return
		const pending = this.pending.get(client) ?? []
		const acknowledged = pending.findIndex(
			({ mutationId }) => mutationId === response.lastMutationId,
		)
		if (acknowledged >= 0) {
			this.pending.set(client, pending.slice(acknowledged + 1))
		}
	}

	/** A crash forgets the incarnation; the restarted one must pull again. */
	crashed(client: Client): void {
		this.pending.delete(client)
		this.received.delete(client)
	}

	/** What the client should show now, or undefined before its first pull. */
	expected(client: Client): DstTodo[] | undefined {
		const received = this.received.get(client)
		if (!received) return undefined
		const state = new Map(received)
		for (const { op } of this.pending.get(client) ?? []) apply(state, op)
		return [...state.values()].sort(byId)
	}

	serverState(): DstTodo[] {
		return [...this.server.values()].sort(byId)
	}

	unacknowledged(client: Client): readonly DstWrite[] {
		return this.pending.get(client) ?? []
	}
}
