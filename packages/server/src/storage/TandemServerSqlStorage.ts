import type {
	AnyCollectionSchema,
	AnySchema,
	CandidateRead,
	CollectionName,
	Operator,
	RuntimeSchemaDefinition,
} from "@tanishqkancharla/tandem-core"
import { match, unreachable } from "@tanishqkancharla/tandem-core"
import { collectionIdToTuple } from "@tanishqkancharla/tandem-core/internal"
import * as errore from "errore"
import {
	DummyDriver,
	Kysely,
	MysqlAdapter,
	MysqlIntrospector,
	MysqlQueryCompiler,
	PostgresAdapter,
	PostgresIntrospector,
	PostgresQueryCompiler,
	SqliteAdapter,
	SqliteIntrospector,
	SqliteQueryCompiler,
	sql,
	type RawBuilder,
} from "kysely"
import { InMemoryTupleStorage } from "tuple-database"
import type { ScanStorageArgs, WriteOps } from "tuple-database"
import { getPrefixContainingBounds } from "tuple-database/helpers/sortedTupleArray.js"
import type {
	TandemServerStorageApi,
	TandemTuple,
} from "./TandemServerStorage.js"

export type TandemSqlDialect = "sqlite" | "postgres" | "mysql"
export type TandemSqlRow = Record<string, unknown>
export type TandemSqlStatement = {
	readonly sql: string
	readonly parameters: readonly unknown[]
}

type IdColumns<Id> = Id extends readonly [unknown, ...unknown[]]
	? { readonly [Index in keyof Id]: string }
	: readonly [string]

/** A record field that one column holds unchanged. */
export type TandemSqlField = {
	column: string
	/** Booleans are 0 and 1 on SQLite and booleans on Postgres. */
	type: "string" | "number" | "boolean"
}

export type TandemSqlTable<Record extends AnyCollectionSchema> = {
	table: string
	/** Primary-key columns in the same order as the record's ID parts. */
	idColumns: IdColumns<Record["id"]>
	/** Encode mapped columns. ID columns are supplied from the record key. */
	encode: (record: Record) => TandemSqlRow
	/** Decode a SQL row, including its scalar or compound ID. */
	decode: (row: TandemSqlRow) => Record
	/**
	 * Fields queries may filter and order on in SQL. Queries filter other
	 * fields after reading. Schema mappings list every field.
	 */
	fields?: { readonly [Field in keyof Record & string]?: TandemSqlField }
}

type TandemSqlTables<Schema extends AnySchema> = {
	[C in CollectionName<Schema>]: TandemSqlTable<Schema[C]>
}

type TandemSqlRuntimeTable<Schema extends AnySchema> = Omit<
	TandemSqlTable<Schema[CollectionName<Schema>]>,
	"idColumns" | "fields"
> & {
	idColumns: readonly string[]
	fields?: { readonly [field: string]: TandemSqlField | undefined }
}

/** Join values read in one statement, well under every dialect's limit. */
const joinValuesPerStatement = 500

export type TandemServerSqlStorageArgs<Schema extends AnySchema> = {
	dialect: TandemSqlDialect
	query: (statement: TandemSqlStatement) => Promise<TandemSqlRow[]>
	/** Execute all statements atomically, or reject without committing any. */
	commit: (statements: readonly TandemSqlStatement[]) => Promise<void>
} & (
	| {
			schema: RuntimeSchemaDefinition<Schema>
			tables?: Partial<TandemSqlTables<Schema>>
	  }
	| { tables: TandemSqlTables<Schema>; schema?: never }
)

class TandemSqlStorageError extends errore.createTaggedError({
	name: "TandemSqlStorageError",
	message: "SQL storage could not $operation",
}) {}

const compilers = {
	sqlite: {
		createAdapter: () => new SqliteAdapter(),
		createQueryCompiler: () => new SqliteQueryCompiler(),
		createIntrospector: (db: Kysely<unknown>) => new SqliteIntrospector(db),
	},
	postgres: {
		createAdapter: () => new PostgresAdapter(),
		createQueryCompiler: () => new PostgresQueryCompiler(),
		createIntrospector: (db: Kysely<unknown>) => new PostgresIntrospector(db),
	},
	mysql: {
		createAdapter: () => new MysqlAdapter(),
		createQueryCompiler: () => new MysqlQueryCompiler(),
		createIntrospector: (db: Kysely<unknown>) => new MysqlIntrospector(db),
	},
}

/**
 * Maps application records onto existing SQL tables. Client acknowledgements
 * are instance-local: this adapter does not yet support restart-safe retries.
 * The host owns the database connection and must serialize writers through one
 * TandemServer. close() never closes the host's database.
 */
export class TandemServerSqlStorage<
	Schema extends AnySchema,
> implements TandemServerStorageApi<Schema> {
	private readonly clients = new InMemoryTupleStorage()
	private readonly compiler: Kysely<unknown>
	private readonly tables: Array<
		[CollectionName<Schema>, TandemSqlRuntimeTable<Schema>]
	>
	private readonly dialect: TandemSqlDialect
	private readonly query: TandemServerSqlStorageArgs<Schema>["query"]
	private readonly commitSql: TandemServerSqlStorageArgs<Schema>["commit"]

	constructor(args: TandemServerSqlStorageArgs<Schema>) {
		this.compiler = new Kysely({
			dialect: {
				...compilers[args.dialect],
				createDriver: () => new DummyDriver(),
			},
		})
		// Erase only the collection-specific parameter type while enumerating the
		// mapping; the public constructor checks each collection independently.
		const tables = args.schema
			? tablesFromSchema({
					schema: args.schema,
					dialect: args.dialect,
					overrides: args.tables,
				})
			: args.tables
		if (tables instanceof Error) throw tables
		this.tables = Object.entries(tables) as typeof this.tables
		this.dialect = args.dialect
		this.query = args.query
		this.commitSql = args.commit
	}

	async scan(args: ScanStorageArgs = {}): Promise<TandemTuple<Schema>[]> {
		// Query reads scan nothing to register a subscription dependency.
		if (args.limit === 0) return []
		const prefix = getPrefixContainingBounds(args)
		const memory = new InMemoryTupleStorage(this.clients.scan())
		for (const [collection, table] of this.tables) {
			if (prefix.length > 0 && prefix[0] !== "record") continue
			if (prefix.length > 1 && prefix[1] !== collection) continue
			const parts = prefix.slice(2)
			if (parts.length > table.idColumns.length) continue
			const conditions = parts.map(
				(part, index) => sql`${sql.id(table.idColumns[index])} = ${part}`,
			)
			const tuples = await this.select(collection, table, conditions)
			if (tuples instanceof Error) throw tuples
			memory.commit({ set: tuples })
		}
		// SQL collations need not match tuple ordering. Apply the exact bounds,
		// ordering and global limit after decoding, without retaining record data.
		return memory.scan(args) as TandemTuple<Schema>[]
	}

	/**
	 * Reads a query node's candidates with SQL: every pushed clause in WHERE,
	 * and with a limit, ORDER BY and LIMIT over the leading number fields of
	 * the order. Rows tied with the last one on those fields are read too, so
	 * the query's own ordering and key-order ties pick the same rows. Returns
	 * undefined when no clause narrows the read, so the query scans instead.
	 */
	async readCandidates(
		read: CandidateRead,
	): Promise<TandemTuple<Schema>[] | undefined> {
		// MySQL's default collations compare strings without case; untested.
		if (this.dialect === "mysql") return
		const collection = read.collection as CollectionName<Schema>
		const table = this.table(collection)
		if (table instanceof Error) throw table
		const fields = table.fields ?? {}
		// A clause SQL cannot decide exactly is left to the query: the read
		// returns a superset, but can no longer apply the limit.
		const where = read.where.flatMap(
			([field, operator, value]) =>
				this.condition(fields[field], operator, value) ?? [],
		)
		const order: RawBuilder<unknown>[] = []
		const orderFields: TandemSqlField[] = []
		for (const [field, direction] of read.order) {
			const definition = fields[field]
			// Scan windows come from clients; only known directions reach SQL.
			const keyword = Object.hasOwn(sqlDirections, direction)
				? sqlDirections[direction]
				: undefined
			if (definition?.type !== "number" || !keyword) break
			order.push(sql`${sql.id(definition.column)} ${keyword}`)
			orderFields.push(definition)
		}
		const limit =
			where.length === read.where.length && order.length && !read.join
				? read.limit
				: undefined
		const join =
			read.join && this.joinValues(fields[read.join.field], read.join.values)
		if (!where.length && !join && limit === undefined) return
		const tuples = await this.readMatches(
			collection,
			table,
			read,
			where,
			{ order, fields: orderFields },
			limit,
			join,
		)
		if (tuples instanceof Error) throw tuples
		// Deduplicate and restore key order.
		const memory = new InMemoryTupleStorage()
		memory.commit({ set: tuples })
		return memory.scan() as TandemTuple<Schema>[]
	}

	private async readMatches(
		collection: CollectionName<Schema>,
		table: TandemSqlRuntimeTable<Schema>,
		read: CandidateRead,
		where: RawBuilder<unknown>[],
		order: { order: RawBuilder<unknown>[]; fields: TandemSqlField[] },
		limit: number | undefined,
		join: { column: string; values: RawBuilder<unknown>[] } | undefined,
	) {
		if (join) {
			const tuples: Exclude<Awaited<ReturnType<typeof this.select>>, Error> = []
			for (
				let index = 0;
				index < join.values.length;
				index += joinValuesPerStatement
			) {
				const values = join.values.slice(index, index + joinValuesPerStatement)
				const chunk = await this.select(collection, table, [
					...where,
					sql`${sql.id(join.column)} in (${sql.join(values)})`,
				])
				if (chunk instanceof Error) return chunk
				tuples.push(...chunk)
			}
			return tuples
		}
		if (limit === undefined) return this.select(collection, table, where)
		if (limit === 0) return []
		// Postgres sorts NaN above every number, while queries treat it as equal
		// to every value. Read all matches when an order field holds NaN.
		if (this.dialect === "postgres") {
			const nan = await this.rows(
				sql`select 1 from ${sql.id(table.table)} ${whereSql([
					...where,
					sql`(${sql.join(
						order.fields.map(
							({ column }) => sql`${sql.id(column)} = ${postgresNaN}`,
						),
						sql` or `,
					)})`,
				])} limit 1`,
			)
			if (nan instanceof Error) return nan
			if (nan.length) return this.select(collection, table, where)
		}
		const top = await this.select(
			collection,
			table,
			where,
			sql`order by ${sql.join(order.order)} limit ${limit}`,
		)
		if (top instanceof Error || top.length < limit) return top
		const last = top.at(-1)!.value as Record<string, unknown>
		const ties = order.fields.map((field, index) =>
			this.condition(field, "=", last[read.order[index]![0]]),
		)
		if (ties.some((tie) => tie === undefined))
			return this.select(collection, table, where)
		const tied = await this.select(collection, table, [
			...where,
			...(ties as RawBuilder<unknown>[]),
		])
		if (tied instanceof Error) return tied
		return [...top, ...tied]
	}

	/** A comparison SQL decides exactly as a query would, if there is one. */
	private condition(
		field: TandemSqlField | undefined,
		operator: Operator,
		value: unknown,
	): RawBuilder<unknown> | undefined {
		// Scan windows come from clients; only known operators reach SQL.
		if (!field || !Object.hasOwn(sqlOperators, operator)) return
		const parameter = this.parameter(field, value)
		if (!parameter) return
		const column = sql.id(field.column)
		if (operator === "=")
			return field.type === "string" && this.dialect === "sqlite"
				? sql`${column} = ${parameter} collate binary`
				: sql`${column} = ${parameter}`
		// Queries order only numbers with numbers; strings compare by UTF-16
		// code unit, which no SQL collation does.
		if (field.type !== "number") return
		const comparison = sql`${column} ${sqlOperators[operator]} ${parameter}`
		if (this.dialect !== "postgres") return comparison
		// Queries treat NaN as equal to every number, so >= and <= match it.
		// Postgres sorts it above every number.
		return match(operator, {
			">": sql`(${comparison} and ${column} <> ${postgresNaN})`,
			"<=": sql`(${comparison} or ${column} = ${postgresNaN})`,
			"<": comparison,
			">=": comparison,
		})
	}

	/**
	 * A SQL value equal to a query value under the field's column, or
	 * undefined when the dialect may compare it differently.
	 */
	private parameter(
		field: TandemSqlField,
		value: unknown,
	): RawBuilder<unknown> | undefined {
		switch (field.type) {
			case "string":
				// Drivers replace lone surrogates; node:sqlite cuts text at NUL and
				// Postgres rejects it.
				return typeof value === "string" &&
					value.isWellFormed() &&
					!value.includes("\0")
					? sql`${value}`
					: undefined
			case "number":
				// D1 binds non-finite numbers as NULL.
				if (typeof value !== "number" || !Number.isFinite(value)) return
				if (this.dialect !== "postgres") return sql`${value}`
				// Without a type, Postgres casts the parameter to the column's type,
				// which rejects fractions for integer columns.
				return Number.isSafeInteger(value)
					? sql`cast(${value} as bigint)`
					: sql`cast(${value} as double precision)`
			case "boolean":
				if (typeof value !== "boolean") return
				return this.dialect === "postgres"
					? sql`cast(${value} as boolean)`
					: sql`${Number(value)}`
			default:
				return unreachable(field.type)
		}
	}

	/**
	 * Join values a column can hold, or undefined when SQL cannot match one of
	 * them exactly. Values of another type never equal a decoded field.
	 */
	private joinValues(
		field: TandemSqlField | undefined,
		values: readonly unknown[],
	) {
		if (!field) return
		const parameters: RawBuilder<unknown>[] = []
		for (const value of values) {
			if (typeof value !== field.type) continue
			// NaN equals nothing, so it joins no rows.
			if (typeof value === "number" && Number.isNaN(value)) continue
			const parameter = this.parameter(field, value)
			if (!parameter) return
			parameters.push(parameter)
		}
		return { column: field.column, values: parameters }
	}

	private async select(
		collection: CollectionName<Schema>,
		table: TandemSqlRuntimeTable<Schema>,
		conditions: RawBuilder<unknown>[],
		tail: RawBuilder<unknown> = sql``,
	) {
		const rows = await this.rows(
			sql`select * from ${sql.id(table.table)} ${whereSql(conditions)} ${tail}`,
		)
		if (rows instanceof Error) return rows
		return errore.try({
			try: () =>
				rows.map((row) => {
					const value = table.decode(row)
					const id = collectionIdToTuple(value.id)
					return { key: ["record", collection, ...id], value }
				}),
			catch: (cause) =>
				new TandemSqlStorageError({ operation: "decode rows", cause }),
		})
	}

	private rows(statement: RawBuilder<unknown>) {
		return this.query(statement.compile(this.compiler)).catch(
			(cause) => new TandemSqlStorageError({ operation: "read rows", cause }),
		)
	}

	async commit(writes: WriteOps<TandemTuple<Schema>>): Promise<void> {
		const statements = this.statements(writes)
		if (statements instanceof Error) throw statements
		if (statements.length) {
			const committed = await this.commitSql(statements).catch(
				(cause) =>
					new TandemSqlStorageError({ operation: "commit rows", cause }),
			)
			if (committed instanceof Error) throw committed
		}
		// Advance receipts only after every SQL write succeeds.
		this.clients.commit({
			set: writes.set?.filter(({ key }) => key[0] === "client"),
			remove: writes.remove?.filter((key) => key[0] === "client"),
		})
	}

	close(): Promise<void> {
		return this.compiler.destroy()
	}

	private statements(writes: WriteOps<TandemTuple<Schema>>) {
		const statements: TandemSqlStatement[] = []
		for (const key of writes.remove ?? []) {
			if (key[0] !== "record") continue
			const table = this.table(key[1])
			if (table instanceof Error) return table
			const conditions = table.idColumns.map(
				(column, index) => sql`${sql.id(column)} = ${key[index + 2]}`,
			)
			statements.push(
				sql`delete from ${sql.id(table.table)} where ${sql.join(conditions, sql` and `)}`.compile(
					this.compiler,
				),
			)
		}
		for (const { key, value } of writes.set ?? []) {
			if (key[0] !== "record") continue
			const table = this.table(key[1])
			if (table instanceof Error) return table
			const encoded = errore.try({
				try: () => table.encode(value as Schema[CollectionName<Schema>]),
				catch: (cause) =>
					new TandemSqlStorageError({ operation: "encode a record", cause }),
			})
			if (encoded instanceof Error) return encoded
			const columns = {
				...encoded,
				...Object.fromEntries(
					table.idColumns.map((column, index) => [column, key[index + 2]]),
				),
			}
			const entries = Object.entries(columns)
			const fields = entries.filter(
				([column]) => !table.idColumns.includes(column),
			)
			const insert = sql`insert into ${sql.id(table.table)} (${sql.join(entries.map(([column]) => sql.id(column)))})`
			const values = sql.join(entries.map(([, value]) => sql.val(value)))
			// Update by primary key first: an INSERT ... ON CONFLICT can reject
			// existing rows whose required, app-owned columns are not mapped.
			const where = sql.join(
				table.idColumns.map(
					(column) => sql`${sql.id(column)} = ${columns[column]}`,
				),
				sql` and `,
			)
			if (fields.length)
				statements.push(
					sql`update ${sql.id(table.table)} set ${sql.join(fields.map(([column, value]) => sql`${sql.id(column)} = ${value}`))} where ${where}`.compile(
						this.compiler,
					),
				)
			statements.push(
				sql`${insert} select ${values} where not exists (select 1 from ${sql.id(table.table)} where ${where})`.compile(
					this.compiler,
				),
			)
		}
		return statements
	}

	private table(collection: CollectionName<Schema>) {
		const entry = this.tables.find(([name]) => name === collection)
		if (!entry)
			return new TandemSqlStorageError({
				operation: `find the table for ${collection}`,
			})
		return entry[1]
	}
}

const postgresNaN = sql`cast('NaN' as double precision)`
const sqlOperators: Record<Operator, RawBuilder<unknown>> = {
	"=": sql`=`,
	">": sql`>`,
	"<": sql`<`,
	">=": sql`>=`,
	"<=": sql`<=`,
}
const sqlDirections: Partial<Record<string, RawBuilder<unknown>>> = {
	asc: sql`asc`,
	desc: sql`desc`,
}

function whereSql(conditions: readonly RawBuilder<unknown>[]) {
	return conditions.length
		? sql`where ${sql.join(conditions, sql` and `)}`
		: sql``
}

function tablesFromSchema<Schema extends AnySchema>(args: {
	schema: RuntimeSchemaDefinition<Schema>
	dialect: TandemSqlDialect
	overrides?: Partial<TandemSqlTables<Schema>>
}) {
	const tables: Record<string, TandemSqlRuntimeTable<Schema>> = {}
	for (const [name, collection] of Object.entries(args.schema.collections)) {
		const override = args.overrides?.[name as CollectionName<Schema>]
		if (override) {
			tables[name] = override
			continue
		}
		const shape = collection.shape
		if (!shape || !["id", "string", "number"].includes(shape.id?.type))
			return new TandemSqlStorageError({
				operation: `map collection "${name}": use collection({ id: t.id(), ... }) with scalar fields, or supply an explicit table mapping`,
			})
		const fields = Object.entries(shape)
		if (
			fields.some(
				([, field]) =>
					!["id", "string", "number", "boolean"].includes(field.type),
			)
		)
			return new TandemSqlStorageError({
				operation: `map unsupported fields in collection "${name}"`,
			})
		tables[name] = {
			table: name,
			idColumns: ["id"],
			// A codec stores values the schema's field types do not describe.
			...(!collection.codec && {
				fields: Object.fromEntries(
					fields.map(([field, definition]) => [
						field,
						{
							column: field,
							type: definition.type === "id" ? "string" : definition.type,
						} as TandemSqlField,
					]),
				),
			}),
			encode: (record) =>
				Object.fromEntries(
					fields.map(([field, definition]) => {
						const value = record[field]
						return [
							field,
							definition.type === "boolean" && args.dialect !== "postgres"
								? Number(value)
								: value,
						]
					}),
				),
			decode: (row) =>
				Object.fromEntries(
					fields.map(([field, definition]) => {
						const value = row[field]
						const decoded =
							definition.type === "boolean" && (value === 0 || value === 1)
								? value === 1
								: value
						const expected =
							definition.type === "id" ? "string" : definition.type
						if (typeof decoded !== expected)
							throw new TandemSqlStorageError({
								operation: `decode "${name}.${field}": expected ${expected}`,
							})
						return [field, decoded]
					}),
				) as Schema[CollectionName<Schema>],
		}
	}
	return tables
}
