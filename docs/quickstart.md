# Quickstart Guide

Get up and running with Tandem in just a few minutes. This guide will walk you through creating a simple todo application that syncs between multiple clients.

## Installation

```bash
npm install tandem
# or
yarn add tandem
# or
pnpm add tandem
```

## 1. Define Your Schema

First, define your data schema using TypeScript interfaces:

```typescript
// schema.ts
export type TodoSchema = {
  todos: {
    id: string
    text: string
    complete: boolean
    createdAt: number
  }
  lists: {
    id: string
    name: string
    color: string
  }
}
```

## 2. Create Your Database

Create a Tandem client instance:

```typescript
// db.ts
import { TandemClient } from "tandem"
import { TodoSchema } from "./schema"

export const db = new TandemClient<TodoSchema>({
  // Optional: Add persistent storage
  storage: new IndexedDbTupleStorage({
    dbName: "my-todo-app",
    version: 1,
  }),
  
  // Optional: Add remote sync (we'll add this later)
  // remote: myRemoteApi,
})

// Wait for initial load from storage
await db.ready
```

## 3. Basic Operations

### Create Records

```typescript
// Create a new todo
const tx = db.transact()
tx.set("todos", {
  id: "todo-1",
  text: "Learn Tandem",
  complete: false,
  createdAt: Date.now(),
})
await db.commit(tx)
```

### Query Records

```typescript
// Get all todos
const todos = db.run("todos", q => q.select("*"))

// Get incomplete todos, ordered by creation date
const incompleteTodos = db.run("todos", q => 
  q.select("*")
   .where("complete", "=", false)
   .order("createdAt", "desc")
)

// Get a specific todo
const todo = db.run("todos", q => q.id("todo-1"))
```

### Update Records

```typescript
// Mark todo as complete
const tx = db.transact()
tx.set("todos", {
  id: "todo-1",
  text: "Learn Tandem",
  complete: true,
  createdAt: Date.now(),
})
await db.commit(tx)
```

### Delete Records

```typescript
// Delete a todo
const tx = db.transact()
tx.remove("todos", "todo-1")
await db.commit(tx)
```

## 4. Real-time Subscriptions

Subscribe to changes for reactive UIs:

```typescript
// Subscribe to all todos
const { result, destroy } = db.subscribe("todos", q => q.select("*"), (todos) => {
  console.log("Todos updated:", todos)
  // Update your UI here
})

// Don't forget to cleanup
destroy() // Call when component unmounts
```

## 5. React Integration

Here's how to use Tandem with React:

```typescript
// hooks/useTodos.ts
import { useEffect, useState } from "react"
import { db } from "../db"
import { TodoSchema } from "../schema"

export function useTodos() {
  const [todos, setTodos] = useState<TodoSchema["todos"][]>([])

  useEffect(() => {
    const { result, destroy } = db.subscribe("todos", q => q.select("*"), setTodos)
    setTodos(result)
    return destroy
  }, [])

  const addTodo = async (text: string) => {
    const tx = db.transact()
    tx.set("todos", {
      id: crypto.randomUUID(),
      text,
      complete: false,
      createdAt: Date.now(),
    })
    await db.commit(tx)
  }

  const toggleTodo = async (id: string) => {
    const currentTodos = db.run("todos", q => q.id(id))
    const todo = currentTodos[0]
    if (todo) {
      const tx = db.transact()
      tx.set("todos", { ...todo, complete: !todo.complete })
      await db.commit(tx)
    }
  }

  const deleteTodo = async (id: string) => {
    const tx = db.transact()
    tx.remove("todos", id)
    await db.commit(tx)
  }

  return { todos, addTodo, toggleTodo, deleteTodo }
}
```

```typescript
// components/TodoApp.tsx
import { useTodos } from "../hooks/useTodos"

export function TodoApp() {
  const { todos, addTodo, toggleTodo, deleteTodo } = useTodos()

  return (
    <div>
      <h1>My Todos</h1>
      
      <form onSubmit={(e) => {
        e.preventDefault()
        const formData = new FormData(e.target as HTMLFormElement)
        const text = formData.get("text") as string
        if (text) {
          addTodo(text)
          e.target.reset()
        }
      }}>
        <input name="text" placeholder="Add a todo..." />
        <button type="submit">Add</button>
      </form>

      <ul>
        {todos.map(todo => (
          <li key={todo.id}>
            <input
              type="checkbox"
              checked={todo.complete}
              onChange={() => toggleTodo(todo.id)}
            />
            <span style={{ textDecoration: todo.complete ? 'line-through' : 'none' }}>
              {todo.text}
            </span>
            <button onClick={() => deleteTodo(todo.id)}>Delete</button>
          </li>
        ))}
      </ul>
    </div>
  )
}
```

## 6. Adding Remote Sync (Optional)

To enable real-time sync between clients, you need to implement a remote API:

```typescript
// remote.ts
import { RemoteApi } from "tandem"
import { TodoSchema } from "./schema"

const remote: RemoteApi<TodoSchema> = {
  async connect({ clientId, poke }) {
    // Connect to your real-time server (WebSocket, SSE, etc.)
    const ws = new WebSocket(`ws://localhost:8080/sync?clientId=${clientId}`)
    
    ws.onmessage = (event) => {
      if (event.data === "poke") {
        poke() // Trigger a pull when server has updates
      }
    }
    
    return async () => {
      ws.close()
    }
  },

  async push({ clientId, mutations }) {
    // Send mutations to your server
    await fetch("/api/sync/push", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ clientId, mutations }),
    })
  },

  async pull({ clientId, cookie, scanWindow }) {
    // Fetch updates from your server
    const response = await fetch("/api/sync/pull", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ clientId, cookie, scanWindow }),
    })
    
    return response.json()
  },
}

// Update your db.ts to use the remote
export const db = new TandemClient<TodoSchema>({
  storage: new IndexedDbTupleStorage({
    dbName: "my-todo-app",
    version: 1,
  }),
  remote, // Add remote sync
})
```

## 7. Advanced Queries

Tandem supports complex queries with type safety:

```typescript
// Filter with multiple conditions
const recentIncompleteTodos = db.run("todos", q => 
  q.select("*")
   .where("complete", "=", false)
   .where("createdAt", ">", Date.now() - 24 * 60 * 60 * 1000) // Last 24 hours
   .order("createdAt", "desc")
   .limit(10)
)

// Select specific fields
const todoSummaries = db.run("todos", q => 
  q.select(["id", "text", "complete"])
   .where("complete", "=", false)
)
```

## 8. Batch Operations

For better performance, batch multiple operations:

```typescript
// Add multiple todos at once
const tx = db.transact()
const todosToAdd = [
  { id: "1", text: "Buy groceries", complete: false, createdAt: Date.now() },
  { id: "2", text: "Walk the dog", complete: false, createdAt: Date.now() },
  { id: "3", text: "Review code", complete: false, createdAt: Date.now() },
]

todosToAdd.forEach(todo => tx.set("todos", todo))
await db.commit(tx)
```

## Next Steps

- **Learn the sync model**: Read [How Does Tandem Work?](./how_does_tandem_work.md) to understand the architecture
- **Implement your backend**: Check out [How to Implement Remote](./how_to_implement_remote.md) for server-side integration
- **Explore the API**: Browse the full API documentation for advanced features

---

**Congratulations!** You now have a working Tandem application with instant UI updates and optional real-time sync. The changes you make will appear immediately in your interface, and if you implement the remote API, they'll sync across all connected clients automatically.