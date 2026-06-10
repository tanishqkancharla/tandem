import { eq } from "drizzle-orm"
import type {
	AnySchema,
	CollectionName,
	EncodedQuery,
	Mutation,
	Patch,
	PatchSetOp,
} from "@tandem/types"
import type { AnyPgColumn, PgDatabase, PgTable } from "drizzle-orm/pg-core"
import { RemoteServer, type RemoteStore } from "../RemoteServer"
import { buildOrderBy, buildWhere, type DrizzleTableWithId } from "./utils"

type PgTableWithId = PgTable & DrizzleTableWithId<AnyPgColumn>
type PgExecutor = Pick<
	PgDatabase<any, any, any>,
	"select" | "insert" | "delete"
>

export type PgDrizzleRemoteArgs<Schema extends AnySchema> = {
	db: PgDatabase<any, any, any>
	tables: {
		readonly [Collection in CollectionName<Schema>]: PgTableWithId
	}
}

class PgDrizzleStore<Schema extends AnySchema> implements RemoteStore<Schema> {
	private readonly db: PgDatabase<any, any, any>
	private readonly tables: PgDrizzleRemoteArgs<Schema>["tables"]

	constructor(args: PgDrizzleRemoteArgs<Schema>) {
		this.db = args.db
		this.tables = args.tables
	}

	async applyMutations(mutations: Mutation<Schema>[]): Promise<void> {
		await this.db.transaction(async (tx) => {
			for (const mutation of mutations) {
				for (const op of mutation.ops) {
					if (op.type === "set") {
						await this.setRecord(tx, op.collection, op.value)
					} else {
						await this.removeRecord(tx, op.collection, op.id)
					}
				}
			}
		})
	}

	async readSnapshot(queries: EncodedQuery<Schema>[]): Promise<Patch<Schema>> {
		const set: PatchSetOp<Schema>[] = []
		for (const query of queries) {
			const rows = await this.readRows(query)
			for (const row of rows) {
				set.push({
					collection: query.collection,
					value: row,
				} as PatchSetOp<Schema>)
			}
		}

		return { set }
	}

	private async setRecord<Collection extends CollectionName<Schema>>(
		db: PgExecutor,
		collection: Collection,
		value: Schema[Collection],
	): Promise<void> {
		const table = this.getTable(collection)
		await db
			.insert(table)
			.values(value as typeof table.$inferInsert)
			.onConflictDoUpdate({
				target: table.id,
				set: value as typeof table.$inferInsert,
			})
	}

	private async removeRecord<Collection extends CollectionName<Schema>>(
		db: PgExecutor,
		collection: Collection,
		id: Schema[Collection]["id"],
	): Promise<void> {
		const table = this.getTable(collection)
		await db.delete(table).where(eq(table.id, id))
	}

	private async readRows<Collection extends CollectionName<Schema>>(
		query: EncodedQuery<Schema, Collection>,
	): Promise<Schema[Collection][]> {
		const table = this.getTable(query.collection)
		let statement = this.db.select().from(table).$dynamic()
		const where = buildWhere(table, query.where)
		if (where) {
			statement = statement.where(where)
		}

		const orderBy = buildOrderBy(table, query.order)
		if (orderBy.length > 0) {
			statement = statement.orderBy(...orderBy)
		}

		if (query.limit !== undefined) {
			statement = statement.limit(query.limit)
		}

		if (query.offset !== undefined) {
			statement = statement.offset(query.offset)
		}

		return (await statement) as Schema[Collection][]
	}

	private getTable<Collection extends CollectionName<Schema>>(
		collection: Collection,
	): PgTableWithId {
		const table = this.tables[collection]
		if (!table) {
			throw new Error(
				`No Drizzle table configured for collection "${collection}"`,
			)
		}

		return table
	}
}

export class PgDrizzleRemote<
	Schema extends AnySchema = AnySchema,
> extends RemoteServer<Schema> {
	constructor(args: PgDrizzleRemoteArgs<Schema>) {
		super({ store: new PgDrizzleStore(args) })
	}
}
