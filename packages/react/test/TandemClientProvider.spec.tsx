/** @vitest-environment jsdom */

import {
	TandemClient,
	collection,
	defineSchema,
	t,
} from "@tanishqkancharla/tandem-core"
import { render, screen, waitFor } from "@testing-library/react"
import { describe, expect, test } from "vitest"
import {
	TandemClientProvider,
	useEntity,
	useTandemClient,
	useTandemQuery,
	useTandemTransaction,
	type UseTandemQuery,
	type UseTandemTransaction,
} from "../src"

type TodoSchema = {
	todos: {
		id: string
		text: string
		complete: boolean
		createdAt: number
	}
}

const useQuery: UseTandemQuery<TodoSchema> = useTandemQuery
const useTransaction: UseTandemTransaction<TodoSchema> = useTandemTransaction

const schema = defineSchema({
	todos: collection({
		id: t.id(),
		text: t.string(),
		complete: t.boolean(),
		createdAt: t.number(),
	}),
})

function createClient() {
	return new TandemClient<TodoSchema>({
		schema,
	})
}

function TodoScreen() {
	const todos =
		useQuery({
			collection: "todos",
			orderBy: { createdAt: "desc" },
		}) ?? []
	const selected = useEntity<TodoSchema, "todos">("todos", todos[0]?.id)
	const addTodo = useTransaction((tx, text: string) => {
		tx.set("todos", {
			id: "todo-1",
			text,
			complete: false,
			createdAt: 1,
		})
	})

	return (
		<div>
			<ul>
				{todos.map((todo) => (
					<li key={todo.id}>{todo.text}</li>
				))}
			</ul>
			<p>{selected?.text ?? "none"}</p>
			<button type="button" onClick={() => addTodo("Ship the docs")}>
				Add
			</button>
		</div>
	)
}

describe("TandemClientProvider", () => {
	test("lists records, writes through a transaction, and looks up the new row by id", async () => {
		const client = createClient()

		render(
			<TandemClientProvider client={client}>
				<TodoScreen />
			</TandemClientProvider>,
		)

		await waitFor(() => {
			expect(screen.getByText("none")).toBeTruthy()
		})

		screen.getByRole("button", { name: "Add" }).click()

		await waitFor(() => {
			expect(screen.getAllByText("Ship the docs")).toHaveLength(2)
		})
	})

	test("hooks fail when used outside TandemClientProvider", () => {
		expect(() => render(<OutsideProvider />)).toThrow(
			"useTandemClient must be used within TandemClientProvider",
		)
	})
})

function OutsideProvider() {
	useTandemClient()
	return null
}
