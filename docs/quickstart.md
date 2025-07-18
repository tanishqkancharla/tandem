# Quickstart Guide

Get up and running with Tandem in 5 minutes. This guide will walk you through creating a simple todo app with real-time sync.

## Installation

```bash
npm install tandem
```

## 1. Define Your Schema

First, define your data structure with TypeScript types:

```typescript
// types.ts
export type TodoSchema = {
  todos: {
    id: string
    text: string
    complete: boolean
    createdAt: number
  }
}
```

## 2. Create the Database

Create a TandemClient instance:

```typescript
// db.ts
import { TandemClient } from "tandem"
import { TodoSchema } from "./types"

export const db = new TandemClient<TodoSchema>({
  // Optional: Add persistent storage
  storage: new IndexedDbTupleStorage({
    dbName: "my-todo-app",
    version: 1,
  }),
  
  // Optional: Add remote sync (see backend guide)
  // remote: myRemoteApi,
})

// Wait for database to be ready
await db.ready
```

## 3. Reading Data

Use the query builder to read data:

```typescript
// Read all todos
const todos = db.run("todos", q => q.select("*"))

// Read incomplete todos
const incompleteTodos = db.run("todos", q => 
  q.select("*")
   .where("complete", false)
   .order("createdAt", "desc")
)

// Read a specific todo
const todo = db.run("todos", q => 
  q.select("*")
   .where("id", "todo-123")
   .limit(1)
)
```

## 4. Subscribing to Changes

Subscribe to get real-time updates:

```typescript
// Subscribe to all todos
const { result, destroy } = db.subscribe("todos", q => q.select("*"), (todos) => {
  console.log("Todos updated:", todos)
  // Update your UI here
})

// Don't forget to cleanup
destroy() // Call this when component unmounts
```

## 5. Making Changes

Use transactions to modify data:

```typescript
// Add a new todo
const tx = db.transact()
tx.set("todos", {
  id: "todo-123",
  text: "Learn Tandem",
  complete: false,
  createdAt: Date.now()
})
await db.commit(tx)

// Update a todo
const tx2 = db.transact()
tx2.set("todos", {
  id: "todo-123",
  text: "Learn Tandem",
  complete: true,  // Mark as complete
  createdAt: Date.now()
})
await db.commit(tx2)

// Delete a todo
const tx3 = db.transact()
tx3.remove("todos", "todo-123")
await db.commit(tx3)
```

## 6. React Integration

Here's how to use Tandem in a React component:

```typescript
// TodoList.tsx
import { useEffect, useState } from "react"
import { db } from "./db"
import { TodoSchema } from "./types"

export function TodoList() {
  const [todos, setTodos] = useState<TodoSchema["todos"][]>([])

  useEffect(() => {
    const { result, destroy } = db.subscribe("todos", q => 
      q.select("*").order("createdAt", "desc"), 
      setTodos
    )
    setTodos(result)
    return destroy
  }, [])

  const addTodo = async (text: string) => {
    const tx = db.transact()
    tx.set("todos", {
      id: crypto.randomUUID(),
      text,
      complete: false,
      createdAt: Date.now()
    })
    await db.commit(tx)
  }

  const toggleTodo = async (id: string) => {
    const todo = db.run("todos", q => q.id(id))[0]
    if (todo) {
      const tx = db.transact()
      tx.set("todos", { ...todo, complete: !todo.complete })
      await db.commit(tx)
    }
  }

  return (
    <div>
      {todos.map(todo => (
        <div key={todo.id}>
          <input
            type="checkbox"
            checked={todo.complete}
            onChange={() => toggleTodo(todo.id)}
          />
          <span>{todo.text}</span>
        </div>
      ))}
      <button onClick={() => addTodo("New todo")}>
        Add Todo
      </button>
    </div>
  )
}
```

## 7. Adding Sync (Optional)

To enable real-time sync between clients, you'll need to implement a backend. See the [Remote Implementation Guide](./how_to_implement_remote.md) for details.

```typescript
// With sync enabled
const db = new TandemClient<TodoSchema>({
  storage: new IndexedDbTupleStorage({
    dbName: "my-todo-app",
    version: 1,
  }),
  remote: {
    async push({ mutations }) {
      // Send mutations to your server
      await fetch("/api/sync/push", {
        method: "POST",
        body: JSON.stringify({ mutations })
      })
    },
    async pull({ cookie, scanWindow }) {
      // Fetch updates from your server
      const response = await fetch("/api/sync/pull", {
        method: "POST",
        body: JSON.stringify({ cookie, scanWindow })
      })
      return response.json()
    },
    async connect(api) {
      // Setup real-time connection (WebSocket, SSE, etc.)
      const ws = new WebSocket("/api/sync/ws")
      ws.onmessage = () => api.poke()
      return () => ws.close()
    }
  }
})
```

## Key Concepts

- **Schema**: Define your data structure with TypeScript types
- **Queries**: Use the query builder to read and filter data
- **Subscriptions**: Get real-time updates when data changes
- **Transactions**: Group operations together for atomic updates
- **Optimistic Updates**: Changes appear instantly, sync happens in background

## Next Steps

- [**How Tandem Works**](./how_does_tandem_work.md) - Understand the sync model
- [**Remote Implementation**](./how_to_implement_remote.md) - Add backend sync
- **API Reference** - Complete API documentation (coming soon)
- **Examples** - More complex examples (coming soon)
