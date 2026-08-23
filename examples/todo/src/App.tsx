import {
	backgroundColor,
	Button,
	Checkbox,
	colors,
	Flex,
	Padding,
	radius,
	shadow,
	text,
	TextField,
} from "@tanishqkancharla/maui"
import {
	useTandemQuery,
	useTandemTransaction,
	type UseTandemQuery,
	type UseTandemTransaction,
} from "@tandem/react"
import { style, useStyles } from "purse-styles"
import { useState } from "react"
import type { TodoSchema } from "./db"

const useQuery: UseTandemQuery<TodoSchema> = useTandemQuery
const useTransaction: UseTandemTransaction<TodoSchema> = useTandemTransaction

const todosQuery = {
	collection: "todos",
	orderBy: { createdAt: "desc" },
} as const

const pageClass = style({
	minHeight: "100vh",
	backgroundColor: backgroundColor.app,
})

const shellClass = style({
	width: "100%",
	maxWidth: "480px",
	marginInline: "auto",
})

const cardClass = style(shadow.subtle, radius.lg, {
	backgroundColor: backgroundColor.element,
	overflow: "hidden",
})

const titleClass = style(text("xl", 600, "highContrast"))
const subtitleClass = style(text("sm", 400, "lowContrast"))
const countClass = style(text("xs", 500, "accent"))
const emptyClass = style(text("sm", 400, "lowContrast"), {
	textAlign: "center",
})
const growClass = style({
	flex: "1 1 auto",
	minWidth: 0,
})
const rowClass = style({
	"& + &": {
		boxShadow: `inset 0 1px 0 ${colors.grayAlpha[4]}`,
	},
})
const completedRowClass = style(rowClass, {
	opacity: 0.7,
	color: colors.gray[10],
})

export function App() {
	const todos = useQuery(todosQuery) ?? []
	const [draft, setDraft] = useState("")
	const remaining = todos.filter((todo) => !todo.complete).length

	const addTodo = useTransaction((tx, text: string) => {
		const trimmed = text.trim()
		if (!trimmed) return

		tx.set("todos", {
			id: crypto.randomUUID(),
			text: trimmed,
			complete: false,
			createdAt: Date.now(),
		})
	})

	const setComplete = useTransaction((tx, id: string, complete: boolean) => {
		tx.update("todos", id, (todo) => ({ ...todo, complete }))
	})

	const removeTodo = useTransaction((tx, id: string) => {
		tx.remove("todos", id)
	})

	const page = useStyles(pageClass)
	const shell = useStyles(shellClass)
	const card = useStyles(cardClass)
	const title = useStyles(titleClass)
	const subtitle = useStyles(subtitleClass)
	const count = useStyles(countClass)
	const empty = useStyles(emptyClass)
	const grow = useStyles(growClass)
	const row = useStyles(rowClass)
	const completedRow = useStyles(completedRowClass)

	return (
		<div className={page}>
			<Padding xy={8}>
				<div className={shell}>
					<Flex column gap={6}>
						<Flex column gap={1}>
							<h1 className={title}>Todos</h1>
							<p className={subtitle}>
								Saved in IndexedDB. Refresh to see them persist.
							</p>
						</Flex>

						<div className={card}>
							<Padding xy={4}>
								<form
									onSubmit={(event) => {
										event.preventDefault()
										addTodo(draft)
										setDraft("")
									}}
								>
									<Flex row alignItems="center" gap={3}>
										<div className={grow}>
											<TextField
												aria-label="New todo"
												placeholder="Add a task"
												value={draft}
												onChange={setDraft}
											/>
										</div>
										<Button type="submit">Add</Button>
									</Flex>
								</form>
							</Padding>

							{todos.length === 0 ? (
								<Padding x={4} y={8}>
									<p className={empty}>
										Nothing here yet. Add a task to get started.
									</p>
								</Padding>
							) : (
								<Flex column>
									{todos.map((todo) => (
										<div
											key={todo.id}
											className={todo.complete ? completedRow : row}
										>
											<Padding x={4} y={3}>
												<Flex row alignItems="center" gap={3}>
													<div className={grow}>
														<Checkbox
															label={todo.text}
															checked={todo.complete}
															setChecked={(complete) =>
																setComplete(todo.id, complete)
															}
														/>
													</div>
													<Button
														variant="quiet"
														onClick={() => removeTodo(todo.id)}
													>
														Delete
													</Button>
												</Flex>
											</Padding>
										</div>
									))}
								</Flex>
							)}

							<Padding x={4} y={3}>
								<p className={count}>{remaining} remaining</p>
							</Padding>
						</div>
					</Flex>
				</div>
			</Padding>
		</div>
	)
}
