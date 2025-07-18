# How to Implement Remote API

This guide shows you how to implement the backend for Tandem's sync system. You'll need to implement three endpoints: `push`, `pull`, and `connect`.

## Remote API Interface

The `RemoteApi` interface defines three methods your backend must implement:

```typescript
interface RemoteApi<Schema> {
  // Send mutations from client to server
  push(args: {
    mutations: Mutation<Schema>[]
    clientId: ClientId
  }): Promise<void>
  
  // Fetch updates from server to client
  pull(args: {
    clientId: ClientId
    cookie?: Cookie
    scanWindow: ScanWindow<Schema>
  }): Promise<{
    cookie: Cookie
    patch: Patch<Schema>
    lastMutationId?: MutationId
  }>
  
  // Setup real-time connection
  connect(api: {
    clientId: ClientId
    poke: () => void
  }): Promise<() => Promise<void>>
}
```

## Implementation Strategies

There are several approaches to implementing the remote API, each with different trade-offs:

### 1. Simple Strategy (Recommended for Getting Started)

**Best for**: Small applications, learning, prototyping

This approach sends the entire dataset on every pull and is simple to implement:

```typescript
// Simple implementation
class SimpleRemote implements RemoteApi<TodoSchema> {
  private todos: Map<string, Todo> = new Map()
  private version = 0

  async push({ mutations }) {
    // Apply mutations directly to in-memory state
    for (const mutation of mutations) {
      for (const op of mutation.ops) {
        if (op.type === "set") {
          this.todos.set(op.value.id, op.value)
        } else if (op.type === "remove") {
          this.todos.delete(op.id)
        }
      }
    }
    this.version++
  }

  async pull({ cookie }) {
    // Always return entire dataset
    const allTodos = Array.from(this.todos.values())
    return {
      cookie: this.version.toString(),
      patch: {
        set: allTodos.map(todo => ({ collection: "todos", value: todo })),
        remove: []
      }
    }
  }

  async connect({ poke }) {
    // No real-time updates in simple version
    return async () => {}
  }
}
```

### 2. Version-Based Strategy

**Best for**: Medium-sized applications with moderate concurrency

This approach tracks a global version number and sends only changes since the last known version:

```typescript
class VersionedRemote implements RemoteApi<TodoSchema> {
  private db: Database // Your database
  private version = 0
  private clients: Map<ClientId, WebSocket> = new Map()

  async push({ mutations, clientId }) {
    // Start transaction
    const tx = this.db.transaction()
    
    try {
      // Apply mutations to database
      for (const mutation of mutations) {
        for (const op of mutation.ops) {
          if (op.type === "set") {
            await tx.query("INSERT OR REPLACE INTO todos VALUES (?, ?, ?)", 
              [op.value.id, op.value.text, op.value.complete])
          } else if (op.type === "remove") {
            await tx.query("DELETE FROM todos WHERE id = ?", [op.id])
          }
        }
      }
      
      // Update global version
      this.version++
      await tx.query("UPDATE metadata SET version = ?", [this.version])
      
      // Track last mutation for this client
      await tx.query("INSERT OR REPLACE INTO client_mutations VALUES (?, ?)",
        [clientId, mutations[mutations.length - 1].id])
      
      await tx.commit()
      
      // Notify other clients
      this.notifyClients(clientId, mutations)
      
    } catch (error) {
      await tx.rollback()
      throw error
    }
  }

  async pull({ clientId, cookie, scanWindow }) {
    const lastVersion = cookie ? parseInt(cookie) : 0
    
    // Get changes since last version
    const changes = await this.db.query(
      "SELECT * FROM todos WHERE version > ?", 
      [lastVersion]
    )
    
    // Get last mutation ID for this client
    const lastMutationId = await this.db.query(
      "SELECT mutation_id FROM client_mutations WHERE client_id = ?",
      [clientId]
    )
    
    // Convert changes to patch format
    const patch = this.changesToPatch(changes, scanWindow)
    
    return {
      cookie: this.version.toString(),
      patch,
      lastMutationId: lastMutationId[0]?.mutation_id
    }
  }

  async connect({ clientId, poke }) {
    // Setup WebSocket connection
    const ws = new WebSocket(clientId)
    this.clients.set(clientId, ws)
    
    ws.on('message', () => poke())
    
    return async () => {
      ws.close()
      this.clients.delete(clientId)
    }
  }

  private notifyClients(excludeClientId: ClientId, mutations: Mutation[]) {
    for (const [clientId, ws] of this.clients) {
      if (clientId !== excludeClientId) {
        ws.send(JSON.stringify({ type: 'poke' }))
      }
    }
  }
}
```

### 3. Row-Level Strategy

**Best for**: Large applications requiring high performance and fine-grained authorization

This approach tracks changes at the individual row level:

```typescript
class RowLevelRemote implements RemoteApi<TodoSchema> {
  private db: Database
  private clients: Map<ClientId, WebSocket> = new Map()

  async push({ mutations, clientId }) {
    const tx = this.db.transaction()
    
    try {
      for (const mutation of mutations) {
        for (const op of mutation.ops) {
          if (op.type === "set") {
            // Update row and increment its version
            await tx.query(`
              INSERT OR REPLACE INTO todos (id, text, complete, version, updated_at)
              VALUES (?, ?, ?, (SELECT COALESCE(MAX(version), 0) + 1 FROM todos), ?)
            `, [op.value.id, op.value.text, op.value.complete, Date.now()])
            
          } else if (op.type === "remove") {
            // Soft delete with version increment
            await tx.query(`
              UPDATE todos 
              SET deleted = 1, version = (SELECT MAX(version) + 1 FROM todos)
              WHERE id = ?
            `, [op.id])
          }
        }
      }
      
      // Track client's last mutation
      await tx.query(`
        INSERT OR REPLACE INTO client_mutations (client_id, mutation_id)
        VALUES (?, ?)
      `, [clientId, mutations[mutations.length - 1].id])
      
      await tx.commit()
      
      this.notifyRelevantClients(mutations)
      
    } catch (error) {
      await tx.rollback()
      throw error
    }
  }

  async pull({ clientId, cookie, scanWindow }) {
    const lastVersion = cookie ? parseInt(cookie) : 0
    
    // Build query based on scan window and authorization
    const authorizedTodos = await this.getAuthorizedTodos(clientId, scanWindow)
    
    // Get changes since last version
    const changes = await this.db.query(`
      SELECT * FROM todos 
      WHERE version > ? 
      AND id IN (${authorizedTodos.map(() => '?').join(',')})
    `, [lastVersion, ...authorizedTodos])
    
    // Get current max version
    const maxVersion = await this.db.query("SELECT MAX(version) as version FROM todos")
    
    // Get last mutation ID for this client
    const lastMutationId = await this.db.query(
      "SELECT mutation_id FROM client_mutations WHERE client_id = ?",
      [clientId]
    )
    
    return {
      cookie: maxVersion[0].version.toString(),
      patch: this.changesToPatch(changes),
      lastMutationId: lastMutationId[0]?.mutation_id
    }
  }

  private async getAuthorizedTodos(clientId: ClientId, scanWindow: ScanWindow<TodoSchema>) {
    // Implement your authorization logic here
    // This could check user permissions, team membership, etc.
    return this.db.query(`
      SELECT t.id FROM todos t
      JOIN user_permissions p ON t.user_id = p.user_id
      WHERE p.client_id = ?
    `, [clientId])
  }
}
```

## Database Schema Examples

### PostgreSQL Schema

```sql
-- Main data tables
CREATE TABLE todos (
    id TEXT PRIMARY KEY,
    text TEXT NOT NULL,
    complete BOOLEAN DEFAULT FALSE,
    version BIGINT DEFAULT 0,
    updated_at TIMESTAMP DEFAULT NOW(),
    deleted BOOLEAN DEFAULT FALSE
);

-- Client mutation tracking
CREATE TABLE client_mutations (
    client_id TEXT PRIMARY KEY,
    mutation_id TEXT NOT NULL,
    updated_at TIMESTAMP DEFAULT NOW()
);

-- Global version tracking (for simple strategy)
CREATE TABLE metadata (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
);

-- Indexes for performance
CREATE INDEX idx_todos_version ON todos(version);
CREATE INDEX idx_todos_updated_at ON todos(updated_at);
CREATE INDEX idx_client_mutations_client_id ON client_mutations(client_id);
```

### MongoDB Schema

```typescript
// Todos collection
{
  _id: "todo-123",
  text: "Learn Tandem",
  complete: false,
  version: 42,
  updatedAt: ISODate("2024-01-01T00:00:00Z"),
  deleted: false
}

// Client mutations collection
{
  _id: "client-abc",
  mutationId: "mutation-456",
  updatedAt: ISODate("2024-01-01T00:00:00Z")
}

// Global version collection
{
  _id: "global",
  version: 1000
}
```

## Real-time Notifications

### WebSocket Implementation

```typescript
// WebSocket-based poke system
class WebSocketPokeSystem {
  private clients: Map<ClientId, WebSocket> = new Map()

  async connect({ clientId, poke }) {
    const ws = new WebSocket(clientId)
    this.clients.set(clientId, ws)
    
    ws.on('message', (data) => {
      const message = JSON.parse(data)
      if (message.type === 'poke') {
        poke()
      }
    })
    
    return async () => {
      ws.close()
      this.clients.delete(clientId)
    }
  }

  notifyClients(excludeClientId: ClientId, mutations: Mutation[]) {
    for (const [clientId, ws] of this.clients) {
      if (clientId !== excludeClientId && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'poke' }))
      }
    }
  }
}
```

### Server-Sent Events Implementation

```typescript
// SSE-based poke system
class SSEPokeSystem {
  private clients: Map<ClientId, Response> = new Map()

  async connect({ clientId, poke }) {
    // Setup SSE endpoint
    const response = new Response(
      new ReadableStream({
        start(controller) {
          this.clients.set(clientId, controller)
          
          // Send keepalive
          const keepalive = setInterval(() => {
            controller.enqueue(': keepalive\n\n')
          }, 30000)
          
          return () => {
            clearInterval(keepalive)
            this.clients.delete(clientId)
          }
        }
      }),
      {
        headers: {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          'Connection': 'keep-alive'
        }
      }
    )
    
    return response
  }

  notifyClients(excludeClientId: ClientId) {
    for (const [clientId, controller] of this.clients) {
      if (clientId !== excludeClientId) {
        controller.enqueue('data: poke\n\n')
      }
    }
  }
}
```

## Error Handling

```typescript
class RobustRemote implements RemoteApi<TodoSchema> {
  async push({ mutations, clientId }) {
    try {
      // Apply mutations with retry logic
      await this.retryOperation(async () => {
        await this.applyMutations(mutations, clientId)
      })
    } catch (error) {
      // Log error and potentially notify client
      console.error('Push failed:', error)
      throw new Error('Failed to apply mutations')
    }
  }

  async pull({ clientId, cookie, scanWindow }) {
    try {
      return await this.retryOperation(async () => {
        return await this.fetchUpdates(clientId, cookie, scanWindow)
      })
    } catch (error) {
      console.error('Pull failed:', error)
      // Return empty patch to prevent client from getting stuck
      return {
        cookie: cookie || '0',
        patch: { set: [], remove: [] }
      }
    }
  }

  private async retryOperation<T>(operation: () => Promise<T>, maxRetries = 3): Promise<T> {
    for (let i = 0; i < maxRetries; i++) {
      try {
        return await operation()
      } catch (error) {
        if (i === maxRetries - 1) throw error
        await this.sleep(Math.pow(2, i) * 1000) // Exponential backoff
      }
    }
    throw new Error('Max retries exceeded')
  }

  private sleep(ms: number) {
    return new Promise(resolve => setTimeout(resolve, ms))
  }
}
```

## Authorization and Security

```typescript
class SecureRemote implements RemoteApi<TodoSchema> {
  async push({ mutations, clientId }) {
    // Verify client authentication
    const user = await this.authenticateClient(clientId)
    if (!user) {
      throw new Error('Unauthorized')
    }

    // Validate each mutation
    for (const mutation of mutations) {
      for (const op of mutation.ops) {
        if (op.type === "set") {
          // Check if user can modify this todo
          if (!await this.canModifyTodo(user, op.value.id)) {
            throw new Error('Forbidden: Cannot modify todo')
          }
          
          // Validate data
          if (!this.validateTodo(op.value)) {
            throw new Error('Invalid todo data')
          }
        }
      }
    }

    // Apply mutations
    await this.applyMutations(mutations, clientId)
  }

  async pull({ clientId, cookie, scanWindow }) {
    const user = await this.authenticateClient(clientId)
    if (!user) {
      throw new Error('Unauthorized')
    }

    // Filter scan window to only include authorized data
    const authorizedScanWindow = await this.filterScanWindow(user, scanWindow)
    
    return await this.fetchUpdates(clientId, cookie, authorizedScanWindow)
  }

  private async canModifyTodo(user: User, todoId: string): Promise<boolean> {
    // Implement your authorization logic
    const todo = await this.db.query("SELECT user_id FROM todos WHERE id = ?", [todoId])
    return todo[0]?.user_id === user.id
  }

  private validateTodo(todo: any): boolean {
    return (
      typeof todo.id === 'string' &&
      typeof todo.text === 'string' &&
      typeof todo.complete === 'boolean' &&
      todo.text.length > 0 &&
      todo.text.length < 1000
    )
  }
}
```

## Testing Your Remote Implementation

```typescript
// Test your remote implementation
describe('Remote API', () => {
  let remote: RemoteApi<TodoSchema>
  
  beforeEach(() => {
    remote = new MyRemote()
  })

  test('push and pull mutations', async () => {
    const clientId = 'test-client'
    
    // Push a mutation
    await remote.push({
      mutations: [{
        id: 'mutation-1',
        ops: [{
          type: 'set',
          collection: 'todos',
          value: { id: 'todo-1', text: 'Test todo', complete: false }
        }]
      }],
      clientId
    })

    // Pull updates
    const result = await remote.pull({
      clientId,
      scanWindow: [{ collection: 'todos' }]
    })

    expect(result.patch.set).toHaveLength(1)
    expect(result.patch.set[0].value.text).toBe('Test todo')
  })

  test('handles concurrent mutations', async () => {
    // Test concurrent push operations
    const client1 = 'client-1'
    const client2 = 'client-2'
    
    await Promise.all([
      remote.push({
        mutations: [/* mutations from client 1 */],
        clientId: client1
      }),
      remote.push({
        mutations: [/* mutations from client 2 */],
        clientId: client2
      })
    ])
    
    // Verify both clients get consistent results
    const result1 = await remote.pull({ clientId: client1, scanWindow: [] })
    const result2 = await remote.pull({ clientId: client2, scanWindow: [] })
    
    expect(result1.patch).toEqual(result2.patch)
  })
})
```

## Performance Optimization

- **Database Indexes**: Index version/timestamp columns for efficient queries
- **Connection Pooling**: Reuse database connections
- **Batch Operations**: Group multiple mutations into single transactions
- **Caching**: Cache frequently accessed data
- **Rate Limiting**: Prevent abuse of push/pull endpoints
- **Compression**: Compress large patches before sending

## Next Steps

- **API Reference** - Complete API documentation (coming soon)
- **Deployment Guide** - Production deployment best practices (coming soon)
- **Examples** - Complete example implementations (coming soon)
