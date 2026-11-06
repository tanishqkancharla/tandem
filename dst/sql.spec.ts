import { PGlite } from "@electric-sql/pglite"
import {
	TandemServerSqlStorage,
	type TandemServerSqlStorageArgs,
	type TandemSqlDialect,
	type TandemSqlRow,
	type TandemSqlStatement,
} from "@tanishqkancharla/tandem-server/sql"
import * as errore from "errore"
import { DatabaseSync } from "node:sqlite"
import { expect, test } from "vitest"
import {
	formatArtifact,
	memorySink,
	parseArtifact,
	replay,
} from "./DstReplay.js"
import { DstSimulation } from "./DstSimulation.js"
import { dstSchemaDefinition, type DstSchema } from "./DstWorld.js"

function tables(dialect: TandemSqlDialect) {
	return {
		tasks: {
			table: "tasks",
			idColumns: ["id"],
			encode: ({ projectId, text, note, done, priority }) => ({
				projectId,
				text,
				note: note ?? null,
				done: dialect === "postgres" ? done : Number(done),
				priority,
			}),
			decode: ({ note, ...rest }) =>
				({
					...rest,
					done: rest.done === true || rest.done === 1,
					...(note === null ? {} : { note }),
				}) as DstSchema["tasks"],
			fields: {
				projectId: { column: "projectId", type: "string" },
				text: { column: "text", type: "string" },
				note: { column: "note", type: "string", nullable: true },
				done: { column: "done", type: "boolean" },
				priority: { column: "priority", type: "number" },
			},
		},
		memberships: {
			table: "memberships",
			idColumns: ["project_id", "member_id"],
			encode: ({ role }) => ({ role }),
			decode: (row) => ({
				id: [row.project_id as string, row.member_id as string],
				role: row.role as string,
			}),
		},
	} satisfies NonNullable<TandemServerSqlStorageArgs<DstSchema>["tables"]>
}

const ddl = (boolean: string) => [
	`create table projects (id text primary key, name text)`,
	`create table tasks (id text primary key, "projectId" text, text text, note text, done ${boolean}, priority integer)`,
	`create index tasks_project_priority on tasks ("projectId", priority)`,
	`create table comments (id text primary key, "taskId" text, body text)`,
	`create index comments_task on comments ("taskId")`,
	`create table memberships (project_id text, member_id text, role text, primary key (project_id, member_id))`,
]

type Database = Pick<
	TandemServerSqlStorageArgs<DstSchema>,
	"query" | "commit"
> & {
	reset: () => Promise<void>
	close: () => Promise<void>
}

async function postgres(): Promise<Database> {
	const db = new PGlite()
	for (const statement of ddl("boolean")) await db.exec(statement)
	return {
		query: async ({ sql, parameters }) =>
			(await db.query<TandemSqlRow>(sql, [...parameters])).rows,
		commit: async (statements) => {
			await db.transaction(async (tx) => {
				for (const { sql, parameters } of statements)
					await tx.query(sql, [...parameters])
			})
		},
		reset: async () => {
			await db.exec("truncate projects, tasks, comments, memberships")
		},
		close: () => db.close(),
	}
}

async function sqlite(): Promise<Database> {
	const db = new DatabaseSync(":memory:")
	for (const statement of ddl("integer")) db.exec(statement)
	const run = ({ sql, parameters }: TandemSqlStatement) =>
		db.prepare(sql).all(...(parameters as never[])) as TandemSqlRow[]
	return {
		query: async (statement) => run(statement),
		commit: async (statements) => {
			db.exec("begin")
			const ran = errore.try(() => statements.forEach(run))
			if (ran instanceof Error) {
				db.exec("rollback")
				throw ran
			}
			db.exec("commit")
		},
		reset: async () => {
			for (const table of ["projects", "tasks", "comments", "memberships"])
				db.exec(`delete from ${table}`)
		},
		close: async () => db.close(),
	}
}

for (const [dialect, open] of [
	["postgres", postgres],
	["sqlite", sqlite],
] as const)
	test.each([3, 7, 19, 42, 81])(
		`${dialect} storage survives network faults and client crashes, seed %i`,
		async (seed) => {
			const db = await open()
			const statements: string[] = []
			const storage = () =>
				new TandemServerSqlStorage<DstSchema>({
					dialect,
					schema: dstSchemaDefinition,
					tables: tables(dialect),
					query: (statement) => {
						statements.push(statement.sql)
						return db.query(statement)
					},
					commit: db.commit,
				})
			const sink = memorySink()
			const result = await new DstSimulation({
				seed,
				steps: 1000,
				faultRate: 0.15,
				crashRate: 0.02,
				namedAppendRate: 0.15,
				// Whole-collection views would answer the paged ones from one scan.
				initialSubscriptions: "scoped",
				subscriptionRate: 0.15,
			}).execute(sink, storage())
			// Violations include every scoped view that differs from the same
			// query answered by a model of the server's records.
			expect(result.violation).toBeUndefined()
			expect(result.coverage.nonemptyViewChecks).toBeGreaterThan(0)
			expect(result.trace.some((event) => event.type === "crash")).toBe(true)
			expect(result.trace.some((event) => event.type === "drop")).toBe(true)
			expect(result.trace.some((event) => event.type === "mutate")).toBe(true)
			// Paged task views and their comment includes ran in SQL.
			expect(statements.some((sql) => / limit /.test(sql))).toBe(true)
			expect(statements.some((sql) => /"taskId" in \(/.test(sql))).toBe(true)
			await db.reset()
			const replayed = await replay(
				parseArtifact(formatArtifact(sink.lines)),
				storage(),
			)
			expect(replayed.divergence).toBeUndefined()
			expect(replayed.violation).toBeUndefined()
			await db.close()
		},
		60_000,
	)
