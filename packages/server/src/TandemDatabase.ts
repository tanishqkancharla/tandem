import type {
	AnySchema,
	CollectionName,
	RelationalQuery,
	RelationalQueryResult,
	RemoteApi,
	RuntimeRelationsDefinition,
	RuntimeSchemaDefinition,
} from "@tanishqkancharla/tandem-core"

/**
 * In-process server analog of TandemClient.
 *
 * Hosts construct it with the same schema and relations as client views and
 * inject it into API handlers. The same instance is a RemoteApi for
 * TandemClient.
 *
 * Direct reads: `await database.query(query)` hits authoritative state. It
 * does not create a replica, cookie, client identity, or subscription.
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
export type TandemDatabaseArgs<
	Schema extends AnySchema,
	Relations extends RuntimeRelationsDefinition<Schema>,
> = {
	schema?: RuntimeSchemaDefinition<Schema>
	relations?: Relations
}

function notImplemented(method: string): never {
	throw new Error(`${method} is not implemented`)
}

export class DatabaseTransaction<Schema extends AnySchema> {
	set<Collection extends CollectionName<Schema>>(
		_collection: Collection,
		_record: Schema[Collection],
	): this {
		return notImplemented("DatabaseTransaction.set")
	}

	update<Collection extends CollectionName<Schema>>(
		_collection: Collection,
		_id: Schema[Collection]["id"],
		_updateFn: (record: Readonly<Schema[Collection]>) => Schema[Collection],
	): this {
		return notImplemented("DatabaseTransaction.update")
	}

	remove<Collection extends CollectionName<Schema>>(
		_collection: Collection,
		_id: Schema[Collection]["id"],
	): this {
		return notImplemented("DatabaseTransaction.remove")
	}

	get<Collection extends CollectionName<Schema>>(
		_collection: Collection,
		_id: Schema[Collection]["id"],
	): Promise<Readonly<Schema[Collection]> | undefined> {
		return notImplemented("DatabaseTransaction.get")
	}

	list<Collection extends CollectionName<Schema>>(
		_collection: Collection,
	): Promise<Readonly<Schema[Collection]>[]> {
		return notImplemented("DatabaseTransaction.list")
	}

	cancel(): void {
		notImplemented("DatabaseTransaction.cancel")
	}
}

export class TandemDatabase<
	Schema extends AnySchema = AnySchema,
	Relations extends RuntimeRelationsDefinition<Schema> =
		RuntimeRelationsDefinition<Schema>,
> implements RemoteApi<Schema> {
	constructor(_args: TandemDatabaseArgs<Schema, Relations>) {}

	query<Query extends RelationalQuery<Schema, Relations>>(
		_query: Query,
	): Promise<RelationalQueryResult<Schema, Relations, Query>> {
		return notImplemented("TandemDatabase.query")
	}

	transact(): DatabaseTransaction<Schema> {
		return notImplemented("TandemDatabase.transact")
	}

	commit(_transaction: DatabaseTransaction<Schema>): Promise<void> {
		return notImplemented("TandemDatabase.commit")
	}

	connect: RemoteApi<Schema>["connect"] = () => {
		return notImplemented("TandemDatabase.connect")
	}

	push: RemoteApi<Schema>["push"] = () => {
		return notImplemented("TandemDatabase.push")
	}

	pull: RemoteApi<Schema>["pull"] = () => {
		return notImplemented("TandemDatabase.pull")
	}

	destroy(): Promise<void> {
		return Promise.resolve()
	}
}
