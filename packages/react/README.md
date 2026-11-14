# @tanishqkancharla/tandem-react

React bindings for [Tandem](https://github.com/tanishqkancharla/tandem), a sync engine and database for collaborative apps.

> [!WARNING]
> Tandem is pre-1.0. APIs change without notice.

```sh
pnpm add @tanishqkancharla/tandem-core @tanishqkancharla/tandem-react
```

```tsx
import {
	TandemClientProvider,
	useTandemQuery,
	useTandemTransaction,
	type UseTandemQuery,
	type UseTandemTransaction,
} from "@tanishqkancharla/tandem-react"
import { db } from "./db" // A TandemClient
import type { TodoSchema } from "./schema"

const useQuery: UseTandemQuery<TodoSchema> = useTandemQuery
const useTransaction: UseTandemTransaction<TodoSchema> = useTandemTransaction

function Todos() {
	const todos = useQuery({ collection: "todos" }) ?? []
	const add = useTransaction((tx, text: string) => {
		tx.set("todos", { id: crypto.randomUUID(), text, complete: false })
	})
	return (
		<>
			{todos.map((todo) => (
				<p key={todo.id}>{todo.text}</p>
			))}
			<button onClick={() => add("New todo")}>Add</button>
		</>
	)
}

export function App() {
	return (
		<TandemClientProvider client={db} connect>
			<Todos />
		</TandemClientProvider>
	)
}
```

The package also exports `useTandemClient` and `useEntity(collection, id)`. The [Quickstart](https://docs.tandemsync.dev/quickstart) builds a full synced app.
