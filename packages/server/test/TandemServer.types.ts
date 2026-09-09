import type {
	Assert,
	TandemClient,
	TestExtends,
	TestIsEqual,
} from "@tanishqkancharla/tandem-core"
import type {
	TandemServer,
	TandemServerArgs,
	TandemServerStore,
} from "@tanishqkancharla/tandem-server"
import type { TaskRelations, TaskSchema } from "./taskSchema"

type _AssertExtends<_A extends _B, _B> = void

type TaskServer = TandemServer<TaskSchema, TaskRelations>
type TaskServerArgs = TandemServerArgs<TaskSchema, TaskRelations>
type Tx = ReturnType<TaskServer["transact"]>

type _TestStoreMatchesAdapter = _AssertExtends<
	TaskServerArgs["store"],
	TandemServerStore<TaskSchema>
>
type _TestStoreMatchesAdapterReverse = _AssertExtends<
	TandemServerStore<TaskSchema>,
	TaskServerArgs["store"]
>

type _TestDirectQueryIsAsync = Assert<
	TestExtends<ReturnType<TaskServer["query"]>, Promise<unknown>>
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

async function serverRelatedTaskQuery(server: TaskServer) {
	return server.query({
		collection: "tasks",
		select: { id: true, title: true, projectId: true },
		with: { project: { select: { name: true } } },
	})
}

type _TestDirectQueryMatchesClient = Assert<
	TestIsEqual<
		Awaited<ReturnType<typeof serverRelatedTaskQuery>>,
		ReturnType<typeof clientRelatedTaskQuery>
	>
>

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
