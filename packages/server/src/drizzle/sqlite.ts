import { eq } from "drizzle-orm"
import type {
	AnySchema,
	CollectionName,
	EncodedQuery,
	Mutation,
	Patch,
	PatchSetOp,
} from "@get-halo/tandem-types"
import type {
	AnySQLiteColumn,
	BaseSQLiteDatabase,
	SQLiteTable,
} from "drizzle-orm/sqlite-core"
import { RemoteServer, type RemoteStore } from "../RemoteServer"
import { buildOrderBy, buildWhere, type DrizzleTableWithId } from "./utils"

type SQLiteTableWithId = SQLiteTable & DrizzleTableWithId<AnySQLiteColumn>
type SQLiteDatabase = BaseSQLiteDatabase<"sync" | "async", any, any, any>
type SQLiteExecutor = Pick<SQLiteDatabase, "select" | "insert" | "delete">

export type SQLiteDrizzleRemoteArgs<Schema extends AnySchema> = {
	db: SQLiteDatabase
	tables: {
		readonly [Collection in CollectionName<Schema>]: SQLiteTableWithId
	}
}

class SQLiteDrizzleStore<
	Schema extends AnySchema,
> implements RemoteStore<Schema> {
	private readonly db: SQLiteDatabase
	private readonly tables: SQLiteDrizzleRemoteArgs<Schema>["tables"]

	constructor(args: SQLiteDrizzleRemoteArgs<Schema>) {
		this.db = args.db
		this.tables = args.tables
	}

	async applyMutations(mutations: Mutation<Schema>[]): Promise<void> {
		for (const mutation of mutations) {
			for (const op of mutation.ops) {
				if (op.type === "set") {
					await this.setRecord(this.db, op.collection, op.value)
				} else {
					await this.removeRecord(this.db, op.collection, op.id)
				}
			}
		}
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
		db: SQLiteExecutor,
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
		db: SQLiteExecutor,
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
	): SQLiteTableWithId {
		const table = this.tables[collection]
		if (!table) {
			throw new Error(
				`No Drizzle table configured for collection "${collection}"`,
			)
		}

		return table
	}
}

export class SQLiteDrizzleRemote<
	Schema extends AnySchema = AnySchema,
> extends RemoteServer<Schema> {
	constructor(args: SQLiteDrizzleRemoteArgs<Schema>) {
		super({ store: new SQLiteDrizzleStore(args) })
	}
}
