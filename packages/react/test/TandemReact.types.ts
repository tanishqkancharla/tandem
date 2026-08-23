import type { RelationalQuery, Transaction } from "@tandem/core"
import type { Assert, TestExtends, TestIsEqual } from "@tandem/core"
import type { RuntimeRelationsDefinition } from "@tandem/types"
import type { useEntity, useQuery, useTransaction } from "../src"

type Todo = {
	id: string
	text: string
	complete: boolean
	createdAt: number
}

type TodoSchema = {
	todos: Todo
}

type TodoRelations = RuntimeRelationsDefinition<TodoSchema>

type TodosQuery = {
	readonly collection: "todos"
	readonly select: { readonly id: true; readonly text: true }
} & RelationalQuery<TodoSchema, TodoRelations, "todos">

type QueryResult = ReturnType<
	typeof useQuery<TodoSchema, TodoRelations, TodosQuery>
>
type QueryRow = NonNullable<QueryResult>[number]
type EntityResult = NonNullable<
	ReturnType<typeof useEntity<TodoSchema, "todos">>
>
type AddTodo = ReturnType<typeof useTransaction<TodoSchema, [text: string]>>

type _QueryRowHasId = Assert<TestIsEqual<QueryRow["id"], string>>
type _QueryRowHasText = Assert<TestIsEqual<QueryRow["text"], string>>
type _EntityIsTodo = Assert<TestIsEqual<EntityResult["text"], string>>
type _AddTodoTakesText = Assert<TestIsEqual<AddTodo, (text: string) => void>>

type _CallbackReceivesTodoTransaction = Assert<
	TestExtends<
		Parameters<typeof useTransaction<TodoSchema, []>>[0],
		(tx: Transaction<TodoSchema>) => void
	>
>
