import type { Transaction } from "@tanishqkancharla/tandem-core"
import type {
	Assert,
	TestExtends,
	TestIsEqual,
} from "@tanishqkancharla/tandem-core"
import {
	useTandemQuery,
	useTandemTransaction,
	type UseTandemQuery,
	type UseTandemTransaction,
} from "../src"

type Todo = {
	id: string
	text: string
	complete: boolean
	createdAt: number
}

type TodoSchema = {
	todos: Todo
}

const useQuery: UseTandemQuery<TodoSchema> = useTandemQuery
const useTransaction: UseTandemTransaction<TodoSchema> = useTandemTransaction

function queryTodos() {
	return useQuery({
		collection: "todos",
		orderBy: { createdAt: "desc" },
	})
}

function addTodo() {
	return useTransaction((tx, text: string) => {
		tx.set("todos", {
			id: "todo-1",
			text,
			complete: false,
			createdAt: 1,
		})
	})
}

type QueryResult = ReturnType<typeof queryTodos>
type QueryRow = NonNullable<QueryResult>[number]
type AddTodo = ReturnType<typeof addTodo>

type _QueryRowsAreTodos = Assert<TestExtends<NonNullable<QueryResult>, Todo[]>>
type _QueryRowHasText = Assert<TestIsEqual<QueryRow["text"], string>>
type _AddTodoTakesText = Assert<TestIsEqual<AddTodo, (text: string) => void>>

type _CallbackReceivesTodoTransaction = Assert<
	TestExtends<
		Parameters<typeof useTransaction>[0],
		(tx: Transaction<TodoSchema>, ...args: never) => void
	>
>
