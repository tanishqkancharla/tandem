import type {
	Assert,
	TandemClient,
	TestExtends,
	TestIsEqual,
} from "@tanishqkancharla/tandem-core"
import type {
	DatabaseTransaction,
	TandemDatabase,
} from "@tanishqkancharla/tandem-server"
import type { TaskRelations, TaskSchema } from "./taskSchema"

type _AssertExtends<_A extends _B, _B> = void

type _TestDirectQueryIsAsync = Assert<
	TestExtends<
		ReturnType<TandemDatabase<TaskSchema, TaskRelations>["query"]>,
		Promise<unknown>
	>
>

function clientRelatedTaskQuery(
	client: TandemClient<TaskSchema, TaskRelations>,
) {
	return client.query({
		collection: "tasks",
		select: { id: true, title: true, projectId: true },
		with: { project: { select: { name: true } } },
	})
}

async function databaseRelatedTaskQuery(
	database: TandemDatabase<TaskSchema, TaskRelations>,
) {
	return database.query({
		collection: "tasks",
		select: { id: true, title: true, projectId: true },
		with: { project: { select: { name: true } } },
	})
}

type _TestDirectQueryMatchesClient = Assert<
	TestIsEqual<
		Awaited<ReturnType<typeof databaseRelatedTaskQuery>>,
		ReturnType<typeof clientRelatedTaskQuery>
	>
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
