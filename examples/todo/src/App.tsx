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
	useTheme,
} from "@tanishqkancharla/maui"
import { style, useStyles } from "purse-styles"
import { useEffect, useState } from "react"
import { db, type Todo } from "./db"

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

function useTodos() {
	const [todos, setTodos] = useState<Todo[]>(() => db.query(todosQuery))

	useEffect(() => {
		const { result, destroy } = db.subscribe(todosQuery, setTodos)
		setTodos(result)
		return destroy
	}, [])

	return todos
}

function addTodo(text: string) {
	const trimmed = text.trim()
	if (!trimmed) return

	const tx = db.transact()
	tx.set("todos", {
		id: crypto.randomUUID(),
		text: trimmed,
		complete: false,
		createdAt: Date.now(),
	})
	void db.commit(tx)
}

function setComplete(id: string, complete: boolean) {
	const tx = db.transact()
	tx.update("todos", id, (todo: Todo) => ({ ...todo, complete }))
	void db.commit(tx)
}

function removeTodo(id: string) {
	const tx = db.transact()
	tx.remove("todos", id)
	void db.commit(tx)
}

function ThemeToggle() {
	const { resolvedTheme, setPreference } = useTheme()

	return (
		<Button
			variant="quiet"
			onClick={() => setPreference(resolvedTheme === "dark" ? "light" : "dark")}
		>
			{resolvedTheme === "dark" ? "Light" : "Dark"}
		</Button>
	)
}

export function App() {
	const todos = useTodos()
	const [draft, setDraft] = useState("")
	const remaining = todos.filter((todo) => !todo.complete).length

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
						<Flex row alignItems="center" gap={3}>
							<div className={grow}>
								<Flex column gap={1}>
									<h1 className={title}>Todos</h1>
									<p className={subtitle}>
										Local Tandem database. No storage, no remote.
									</p>
								</Flex>
							</div>
							<ThemeToggle />
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
