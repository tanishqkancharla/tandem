import type {
	NormalizedManyToOneRelationDefinition,
	NormalizedOneToManyRelationDefinition,
	RelationalQueryResult,
	TandemClient,
} from "@tanishqkancharla/tandem-core"
import type {
	DatabaseTransaction,
	SchemaFromDrizzleTables,
	TandemDatabase,
} from "@tanishqkancharla/tandem-server"
import type {
	Assert,
	TestExtends,
	TestIsEqual,
} from "@tanishqkancharla/tandem-core"
import { taskTables } from "./taskSchema"

type _AssertExtends<_A extends _B, _B> = void

type TaskSchema = SchemaFromDrizzleTables<typeof taskTables>

type _TestDoneIsBoolean = _AssertExtends<TaskSchema["tasks"]["done"], boolean>
type _TestDoneIsBooleanReverse = _AssertExtends<
	boolean,
	TaskSchema["tasks"]["done"]
>
type _TestProjectIdIsNullable = _AssertExtends<
	TaskSchema["tasks"]["projectId"],
	string | null
>
type _TestProjectIdIsNullableReverse = _AssertExtends<
	string | null,
	TaskSchema["tasks"]["projectId"]
>
type _TestTitleIsString = _AssertExtends<TaskSchema["tasks"]["title"], string>
type _TestTitleIsStringReverse = _AssertExtends<
	string,
	TaskSchema["tasks"]["title"]
>
type _TestProjectNameIsString = _AssertExtends<
	TaskSchema["projects"]["name"],
	string
>
type _TestProjectNameIsStringReverse = _AssertExtends<
	string,
	TaskSchema["projects"]["name"]
>

type TaskRelations = {
	tasks: {
		project: NormalizedManyToOneRelationDefinition<
			TaskSchema,
			"tasks",
			"projects",
			"project"
		>
	}
	projects: {
		tasks: NormalizedOneToManyRelationDefinition<
			TaskSchema,
			"projects",
			"tasks",
			"tasks"
		>
	}
}

type _TestDirectQueryIsAsync = Assert<
	TestExtends<
		ReturnType<TandemDatabase<TaskSchema, TaskRelations>["query"]>,
		Promise<unknown>
	>
>

function clientTaskQuery(client: TandemClient<TaskSchema, TaskRelations>) {
	return client.query({ collection: "tasks" })
}

function clientSelectedTaskQuery(
	client: TandemClient<TaskSchema, TaskRelations>,
) {
	return client.query({
		collection: "tasks",
		select: { id: true, done: true, projectId: true },
	})
}

function clientRelatedTaskQuery(
	client: TandemClient<TaskSchema, TaskRelations>,
) {
	return client.query({
		collection: "tasks",
		select: { id: true, title: true, projectId: true },
		with: { project: { select: { name: true } } },
	})
}

type _TestClientTaskDone = _AssertExtends<
	ReturnType<typeof clientTaskQuery>[number]["done"],
	boolean
>
type _TestClientTaskDoneReverse = _AssertExtends<
	boolean,
	ReturnType<typeof clientTaskQuery>[number]["done"]
>
type _TestClientTaskProjectId = _AssertExtends<
	ReturnType<typeof clientTaskQuery>[number]["projectId"],
	string | null
>
type _TestClientTaskProjectIdReverse = _AssertExtends<
	string | null,
	ReturnType<typeof clientTaskQuery>[number]["projectId"]
>
type _TestClientSelectedTask = Assert<
	TestIsEqual<
		ReturnType<typeof clientSelectedTaskQuery>[number],
		{ id: string; done: boolean; projectId: string | null }
	>
>
type _TestClientRelatedTask = Assert<
	TestIsEqual<
		ReturnType<typeof clientRelatedTaskQuery>[number],
		{
			id: string
			title: string
			projectId: string | null
			readonly project: { name: string } | null
		}
	>
>

async function directSelectedQuery(
	database: TandemDatabase<TaskSchema, TaskRelations>,
) {
	return database.query({
		collection: "tasks",
		select: { id: true, done: true, projectId: true },
	})
}

type _TestDirectSelectedTask = Assert<
	TestIsEqual<
		Awaited<ReturnType<typeof directSelectedQuery>>[number],
		{ id: string; done: boolean; projectId: string | null }
	>
>

type _TestSelectedDirectQuery = Assert<
	TestIsEqual<
		RelationalQueryResult<
			TaskSchema,
			TaskRelations,
			{
				collection: "tasks"
				select: { id: true; title: true; projectId: true }
				with: { project: { select: { name: true } } }
			}
		>,
		{
			id: string
			title: string
			projectId: string | null
			readonly project: { name: string } | null
		}[]
	>
>

type _TestUnselectedTaskQuery = Assert<
	TestIsEqual<
		RelationalQueryResult<TaskSchema, TaskRelations, { collection: "tasks" }>,
		TaskSchema["tasks"][]
	>
>

type _TestInvalidSelectField = NonNullable<
	RelationalQueryResult<
		TaskSchema,
		TaskRelations,
		// @ts-expect-error Selected fields must exist on tasks
		{ collection: "tasks"; select: { missingField: true } }
	>
>

type _TestInvalidSetDone = _AssertExtends<
	// @ts-expect-error done is boolean
	"yes",
	TaskSchema["tasks"]["done"]
>

type _TestInvalidSetProjectId = _AssertExtends<
	// @ts-expect-error projectId is string | null
	123,
	TaskSchema["tasks"]["projectId"]
>

type Tx = DatabaseTransaction<TaskSchema>
type _TestSetCollections = _AssertExtends<
	Parameters<Tx["set"]>[0],
	"projects" | "tasks"
>
type _TestSetCollectionsReverse = _AssertExtends<
	"projects" | "tasks",
	Parameters<Tx["set"]>[0]
>

type _TestTransactionGetIsAsync = Assert<
	TestExtends<ReturnType<Tx["get"]>, Promise<unknown>>
>
type _TestTransactionListIsAsync = Assert<
	TestExtends<ReturnType<Tx["list"]>, Promise<unknown>>
>
