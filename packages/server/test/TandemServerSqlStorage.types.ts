import {
	collection,
	defineSchema,
	t,
	type SchemaFromCollections,
} from "@tanishqkancharla/tandem-core"
import type mysql from "mysql2"
import type pg from "pg"
import {
	TandemServerD1Storage,
	TandemServerPostgresStorage,
	TandemServerMysqlStorage,
	type TandemD1Database,
} from "../src/sql.js"
import { expectTypeOf } from "vitest"
import type { TandemServerStorageApi } from "../src/index.js"
import {
	TandemServerSqlStorage,
	type TandemSqlTable,
} from "../src/storage/TandemServerSqlStorage.js"

type Schema = {
	users: { id: string; name: string }
	entries: { id: readonly [string, number]; body: string }
}

declare const users: TandemSqlTable<Schema["users"]>
declare const entries: TandemSqlTable<Schema["entries"]>
expectTypeOf(users.encode).parameter(0).toEqualTypeOf<Schema["users"]>()
expectTypeOf(entries.decode).returns.toEqualTypeOf<Schema["entries"]>()
expectTypeOf(entries.idColumns).toEqualTypeOf<readonly [string, string]>()

const invalid: TandemSqlTable<Schema["entries"]> = {
	table: "entries",
	// @ts-expect-error Both parts of a compound ID need SQL columns.
	idColumns: ["id"],
	encode: ({ body }) => ({ body }),
	decode: entries.decode,
}
void invalid

const storage = new TandemServerSqlStorage<Schema>({
	dialect: "sqlite",
	tables: { users, entries },
	query: async () => [],
	commit: async () => {},
})
expectTypeOf(storage).toMatchTypeOf<TandemServerStorageApi<Schema>>()

const schema = defineSchema({
	tasks: collection({ id: t.id(), text: t.string(), done: t.boolean() }),
})
type InferredSchema = SchemaFromCollections<typeof schema.collections>
declare const d1: TandemD1Database
declare const postgres: pg.Pool
declare const mysqlPool: mysql.Pool
const d1Storage = new TandemServerD1Storage({ schema, database: d1 })
const postgresStorage = new TandemServerPostgresStorage({
	schema,
	database: postgres,
})
const mysqlStorage = new TandemServerMysqlStorage({
	schema,
	database: mysqlPool,
})
expectTypeOf(d1Storage).toEqualTypeOf<TandemServerD1Storage<InferredSchema>>()
expectTypeOf(postgresStorage).toEqualTypeOf<
	TandemServerPostgresStorage<InferredSchema>
>()
expectTypeOf(mysqlStorage).toEqualTypeOf<
	TandemServerMysqlStorage<InferredSchema>
>()
