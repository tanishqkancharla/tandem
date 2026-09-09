import type {
	AnySchema,
	CollectionName,
	LoggerApi,
	RelationalQuery,
	RelationalQueryResult,
	RemoteApi,
	RuntimeRelationsDefinition,
	RuntimeSchemaDefinition,
} from "@tanishqkancharla/tandem-core"
import { ConsoleLoggerSink, Logger } from "@tanishqkancharla/tandem-core"

/**
 * Authoritative in-process analog of TandemClient.
 *
 * Construct this on the backend with the same schema and relations as client
 * views. Use `query` / `transact` / `commit` from API handlers. Frontend
 * clients do not hold this instance; they pass a RemoteApi transport
 * (`push` / `pull` / `connect`) that reaches these methods over the network.
 *
 * Same-process tests and handlers may pass the instance as
 * `new TandemClient({ remote: server })` because TandemServer is a RemoteApi.
 *
 * Direct reads: `await server.query(query)` hits authoritative state. It does
 * not create a replica, cookie, client identity, or subscription.
 *
 * Direct writes keep Tandem's authoring pattern: `transact()`, `tx.set` /
 * `tx.update` / `tx.remove`, `await commit(tx)`, and `cancel()`. `set`,
 * `update`, and `remove` stay synchronous. `update` still changes a record
 * only if it exists. Update callbacks run against this transaction's
 * authoritative state when the operation is applied, including earlier writes
 * in the same transaction.
 *
 * Transaction reads are the documented async difference from TandemClient:
 * `await tx.get(collection, id)` and `await tx.list(collection)` observe
 * this transaction's staged writes. They are not a synchronous local replica.
 *
 * `commit(tx)` and `push(...)` share one apply-then-notify path. A commit or
 * push is atomic as a whole: failure rejects, publishes nothing, and does not
 * acknowledge the originating client. Direct commits never acknowledge
 * another client's optimistic mutations.
 */
export type TandemServerArgs<
	Schema extends AnySchema,
	Relations extends RuntimeRelationsDefinition<Schema>,
> = {
	schema?: RuntimeSchemaDefinition<Schema>
	relations?: Relations
	/**
	 * @default ConsoleLoggerSink
	 */
	logger?: LoggerApi
}

function notImplemented(method: string): never {
	throw new Error(`${method} is not implemented`)
}

export class TandemServerTransaction<Schema extends AnySchema> {
	set<Collection extends CollectionName<Schema>>(
		_collection: Collection,
		_record: Schema[Collection],
	): this {
		return notImplemented("TandemServerTransaction.set")
	}

	update<Collection extends CollectionName<Schema>>(
		_collection: Collection,
		_id: Schema[Collection]["id"],
		_updateFn: (record: Readonly<Schema[Collection]>) => Schema[Collection],
	): this {
		return notImplemented("TandemServerTransaction.update")
	}

	remove<Collection extends CollectionName<Schema>>(
		_collection: Collection,
		_id: Schema[Collection]["id"],
	): this {
		return notImplemented("TandemServerTransaction.remove")
	}

	get<Collection extends CollectionName<Schema>>(
		_collection: Collection,
		_id: Schema[Collection]["id"],
	): Promise<Readonly<Schema[Collection]> | undefined> {
		return notImplemented("TandemServerTransaction.get")
	}

	list<Collection extends CollectionName<Schema>>(
		_collection: Collection,
	): Promise<Readonly<Schema[Collection]>[]> {
		return notImplemented("TandemServerTransaction.list")
	}

	cancel(): void {
		notImplemented("TandemServerTransaction.cancel")
	}
}

export class TandemServer<
	Schema extends AnySchema = AnySchema,
	Relations extends RuntimeRelationsDefinition<Schema> =
		RuntimeRelationsDefinition<Schema>,
> implements RemoteApi<Schema> {
	private readonly logger: LoggerApi

	constructor({ logger }: TandemServerArgs<Schema, Relations>) {
		this.logger = logger ?? new Logger({ sinks: new ConsoleLoggerSink() })
	}

	query<Query extends RelationalQuery<Schema, Relations>>(
		_query: Query,
	): Promise<RelationalQueryResult<Schema, Relations, Query>> {
		return notImplemented("TandemServer.query")
	}

	transact(): TandemServerTransaction<Schema> {
		return notImplemented("TandemServer.transact")
	}

	commit(_transaction: TandemServerTransaction<Schema>): Promise<void> {
		return notImplemented("TandemServer.commit")
	}

	connect: RemoteApi<Schema>["connect"] = () => {
		return notImplemented("TandemServer.connect")
	}

	push: RemoteApi<Schema>["push"] = () => {
		return notImplemented("TandemServer.push")
	}

	pull: RemoteApi<Schema>["pull"] = () => {
		return notImplemented("TandemServer.pull")
	}

	destroy(): Promise<void> {
		return Promise.resolve()
	}
}
