# How to Implement Remote

This guide explains how to implement the server-side `RemoteApi` for Tandem sync. The remote API consists of three endpoints that handle the push-pull sync model and real-time notifications.

## RemoteApi Interface

Your server must implement this interface:

```typescript
interface RemoteApi<Schema> {
  // Handle client connections and real-time notifications
  connect(api: { clientId: string; poke: () => void }): Promise<() => void>
  
  // Receive mutations from clients
  push(args: { 
    mutations: Mutation<Schema>[]
    clientId: string 
  }): Promise<void>
  
  // Send updates to clients
  pull(args: { 
    clientId: string
    cookie?: string | number
    scanWindow: ScanWindow<Schema>
  }): Promise<{
    cookie: string | number
    patch: Patch<Schema>
    lastMutationId?: string
  }>
}
```

## Strategy Overview

There are several strategies for implementing the remote API, each with different trade-offs:

| Strategy | Complexity | Concurrency | Best For |
|----------|------------|-------------|----------|
| **Reset** | Low | N/A | Prototypes, small datasets |
| **Global Version** | Medium | ~50 pushes/sec | Simple applications |
| **Per-Space Version** | Medium | ~50 pushes/sec per space | Multi-tenant apps |
| **Row Version** | High | High | Production applications |

## Strategy 1: Reset (Simplest)

The reset strategy recomputes and retransmits the entire client view on each pull.

### Implementation

```typescript
class ResetRemoteApi implements RemoteApi<Schema> {
  private clients = new Map<string, { poke: () => void }>()
  private database: Database // Your database

  async connect({ clientId, poke }) {
    this.clients.set(clientId, { poke })
    
    return async () => {
      this.clients.delete(clientId)
    }
  }

  async push({ mutations, clientId }) {
    // Apply mutations to your database
    for (const mutation of mutations) {
      await this.applyMutation(mutation)
    }
    
    // Notify all other clients
    for (const [id, client] of this.clients) {
      if (id !== clientId) {
        client.poke()
      }
    }
  }

  async pull({ clientId, cookie, scanWindow }) {
    // Ignore cookie - always return full state
    const patch = await this.computeFullPatch(scanWindow)
    
    return {
      cookie: Date.now(), // Simple versioning
      patch,
      lastMutationId: undefined
    }
  }

  private async computeFullPatch(scanWindow: ScanWindow<Schema>) {
    const patch: Patch<Schema> = { set: [], remove: [] }
    
    // For each query in scan window, fetch all matching records
    for (const query of scanWindow) {
      const records = await this.database.query(query)
      
      for (const record of records) {
        patch.set!.push({
          collection: query.collection,
          value: record
        })
      }
    }
    
    return patch
  }
}
```

### Pros & Cons

**Pros:**
- Simple to implement
- No versioning complexity
- Always consistent

**Cons:**
- High bandwidth usage
- Poor performance with large datasets
- No support for deletions without full scan

## Strategy 2: Global Version

Use a single version number for the entire application.

### Implementation

```typescript
class GlobalVersionRemoteApi implements RemoteApi<Schema> {
  private version = 0
  private changes: Array<{ version: number, patch: Patch<Schema> }> = []
  private clients = new Map<string, { poke: () => void }>()

  async connect({ clientId, poke }) {
    this.clients.set(clientId, { poke })
    
    return async () => {
      this.clients.delete(clientId)
    }
  }

  async push({ mutations, clientId }) {
    // Apply mutations in a transaction
    await this.database.transaction(async (tx) => {
      for (const mutation of mutations) {
        await this.applyMutation(mutation, tx)
      }
      
      // Increment version
      this.version++
      
      // Record changes
      const patch = await this.mutationsToPatch(mutations)
      this.changes.push({ version: this.version, patch })
      
      // Cleanup old changes (keep last 1000)
      if (this.changes.length > 1000) {
        this.changes = this.changes.slice(-1000)
      }
    })
    
    // Notify clients
    for (const [id, client] of this.clients) {
      if (id !== clientId) {
        client.poke()
      }
    }
  }

  async pull({ clientId, cookie, scanWindow }) {
    const fromVersion = cookie ? parseInt(cookie as string) : 0
    
    // Get all changes since fromVersion
    const relevantChanges = this.changes.filter(
      change => change.version > fromVersion
    )
    
    // Merge patches
    const patch = this.mergePatches(relevantChanges.map(c => c.patch))
    
    // Filter patch by scan window
    const filteredPatch = await this.filterPatchByScanWindow(patch, scanWindow)
    
    return {
      cookie: this.version.toString(),
      patch: filteredPatch,
      lastMutationId: undefined
    }
  }

  private async filterPatchByScanWindow(
    patch: Patch<Schema>, 
    scanWindow: ScanWindow<Schema>
  ) {
    // Only include changes that match the scan window
    const filteredPatch: Patch<Schema> = { set: [], remove: [] }
    
    for (const setOp of patch.set || []) {
      const matchesWindow = scanWindow.some(query => 
        query.collection === setOp.collection &&
        this.recordMatchesQuery(setOp.value, query)
      )
      
      if (matchesWindow) {
        filteredPatch.set!.push(setOp)
      }
    }
    
    for (const removeOp of patch.remove || []) {
      const matchesWindow = scanWindow.some(query => 
        query.collection === removeOp.collection
      )
      
      if (matchesWindow) {
        filteredPatch.remove!.push(removeOp)
      }
    }
    
    return filteredPatch
  }
}
```

### Pros & Cons

**Pros:**
- Incremental updates
- Reasonable performance
- Simpler than row-level versioning

**Cons:**
- Limited concurrency (~50 pushes/sec)
- Global version can become bottleneck
- Complex scan window filtering

## Strategy 3: Per-Space Version

Partition your data into "spaces" (e.g., organizations, teams, projects) with independent versioning.

### Implementation

```typescript
class PerSpaceVersionRemoteApi implements RemoteApi<Schema> {
  private spaceVersions = new Map<string, number>()
  private spaceChanges = new Map<string, Array<{ version: number, patch: Patch<Schema> }>>()
  private clients = new Map<string, { poke: () => void, spaces: Set<string> }>()

  async connect({ clientId, poke }) {
    this.clients.set(clientId, { poke, spaces: new Set() })
    
    return async () => {
      this.clients.delete(clientId)
    }
  }

  async push({ mutations, clientId }) {
    // Group mutations by space
    const mutationsBySpace = this.groupMutationsBySpace(mutations)
    
    for (const [spaceId, spaceMutations] of mutationsBySpace) {
      await this.database.transaction(async (tx) => {
        // Apply mutations
        for (const mutation of spaceMutations) {
          await this.applyMutation(mutation, tx)
        }
        
        // Increment space version
        const currentVersion = this.spaceVersions.get(spaceId) || 0
        const newVersion = currentVersion + 1
        this.spaceVersions.set(spaceId, newVersion)
        
        // Record changes
        const patch = await this.mutationsToPatch(spaceMutations)
        const spaceChanges = this.spaceChanges.get(spaceId) || []
        spaceChanges.push({ version: newVersion, patch })
        this.spaceChanges.set(spaceId, spaceChanges)
      })
    }
    
    // Notify relevant clients
    for (const [id, client] of this.clients) {
      if (id !== clientId) {
        const hasRelevantSpace = [...mutationsBySpace.keys()].some(
          spaceId => client.spaces.has(spaceId)
        )
        if (hasRelevantSpace) {
          client.poke()
        }
      }
    }
  }

  async pull({ clientId, cookie, scanWindow }) {
    // Parse space cookies
    const spaceCookies = this.parseSpaceCookies(cookie)
    
    // Update client spaces based on scan window
    const client = this.clients.get(clientId)
    if (client) {
      client.spaces = new Set(this.extractSpacesFromScanWindow(scanWindow))
    }
    
    // Get changes for each space
    const patches: Patch<Schema>[] = []
    const newSpaceCookies: Record<string, number> = {}
    
    for (const spaceId of client?.spaces || []) {
      const fromVersion = spaceCookies[spaceId] || 0
      const spaceChanges = this.spaceChanges.get(spaceId) || []
      
      const relevantChanges = spaceChanges.filter(
        change => change.version > fromVersion
      )
      
      if (relevantChanges.length > 0) {
        const spacePatch = this.mergePatches(relevantChanges.map(c => c.patch))
        patches.push(spacePatch)
      }
      
      newSpaceCookies[spaceId] = this.spaceVersions.get(spaceId) || 0
    }
    
    // Merge all patches
    const finalPatch = this.mergePatches(patches)
    
    return {
      cookie: JSON.stringify(newSpaceCookies),
      patch: finalPatch,
      lastMutationId: undefined
    }
  }

  private groupMutationsBySpace(mutations: Mutation<Schema>[]) {
    const groups = new Map<string, Mutation<Schema>[]>()
    
    for (const mutation of mutations) {
      const spaceId = this.extractSpaceFromMutation(mutation)
      const group = groups.get(spaceId) || []
      group.push(mutation)
      groups.set(spaceId, group)
    }
    
    return groups
  }

  private extractSpaceFromMutation(mutation: Mutation<Schema>): string {
    // Extract space ID from mutation - this is app-specific
    // Example: use organizationId from record
    const firstOp = mutation.ops[0]
    return firstOp.type === 'set' ? firstOp.value.organizationId : 'default'
  }
}
```

### Pros & Cons

**Pros:**
- Better concurrency than global version
- Natural data partitioning
- Scales with number of spaces

**Cons:**
- More complex implementation
- Requires clear space boundaries
- Still limited by single-space contention

## Strategy 4: Row Version (Production)

Use row-level versioning for maximum flexibility and performance.

### Implementation

```typescript
class RowVersionRemoteApi implements RemoteApi<Schema> {
  private clients = new Map<string, { 
    poke: () => void
    lastMutationId?: string
    scanWindow: ScanWindow<Schema>
  }>()

  async connect({ clientId, poke }) {
    this.clients.set(clientId, { 
      poke, 
      lastMutationId: undefined,
      scanWindow: [] 
    })
    
    return async () => {
      this.clients.delete(clientId)
    }
  }

  async push({ mutations, clientId }) {
    let lastMutationId: string | undefined
    
    await this.database.transaction(async (tx) => {
      for (const mutation of mutations) {
        // Apply mutation and update row versions
        await this.applyMutationWithVersion(mutation, tx)
        lastMutationId = mutation.id
      }
    })
    
    // Update client state
    const client = this.clients.get(clientId)
    if (client) {
      client.lastMutationId = lastMutationId
    }
    
    // Notify relevant clients
    for (const [id, otherClient] of this.clients) {
      if (id !== clientId) {
        const needsPoke = mutations.some(mutation =>
          this.mutationIntersectsScanWindow(mutation, otherClient.scanWindow)
        )
        if (needsPoke) {
          otherClient.poke()
        }
      }
    }
  }

  async pull({ clientId, cookie, scanWindow }) {
    // Update client scan window
    const client = this.clients.get(clientId)
    if (client) {
      client.scanWindow = scanWindow
    }
    
    // Parse cookie as last known row versions
    const lastVersions = this.parseCookie(cookie)
    
    // Build patch from row-level changes
    const patch = await this.buildRowVersionPatch(scanWindow, lastVersions)
    
    // Generate new cookie with current row versions
    const newCookie = await this.generateCookie(scanWindow)
    
    return {
      cookie: newCookie,
      patch,
      lastMutationId: client?.lastMutationId
    }
  }

  private async buildRowVersionPatch(
    scanWindow: ScanWindow<Schema>,
    lastVersions: Record<string, number>
  ) {
    const patch: Patch<Schema> = { set: [], remove: [] }
    
    for (const query of scanWindow) {
      // Find all records matching query that have changed
      const sql = `
        SELECT * FROM ${query.collection} 
        WHERE version > ? 
        AND ${this.buildWhereClause(query.where)}
        ORDER BY ${this.buildOrderClause(query.order)}
        LIMIT ${query.limit || 1000}
      `
      
      const lastVersion = lastVersions[query.collection] || 0
      const records = await this.database.query(sql, [lastVersion])
      
      for (const record of records) {
        if (record.deleted) {
          patch.remove!.push({
            collection: query.collection,
            id: record.id
          })
        } else {
          patch.set!.push({
            collection: query.collection,
            value: record
          })
        }
      }
    }
    
    return patch
  }

  private async applyMutationWithVersion(mutation: Mutation<Schema>, tx: Transaction) {
    for (const op of mutation.ops) {
      if (op.type === 'set') {
        await tx.query(`
          INSERT OR REPLACE INTO ${op.collection} 
          SET ${this.buildSetClause(op.value)}, version = version + 1
        `)
      } else if (op.type === 'remove') {
        await tx.query(`
          UPDATE ${op.collection} 
          SET deleted = true, version = version + 1 
          WHERE id = ?
        `, [op.id])
      }
    }
  }
}
```

### Pros & Cons

**Pros:**
- Maximum concurrency
- Fine-grained permissions
- Efficient incremental sync
- Scales to large datasets

**Cons:**
- Complex implementation
- Requires database schema changes
- More storage overhead

## Real-time Notifications

All strategies can use the same poke mechanism for real-time updates:

### WebSocket Implementation

```typescript
// Server-side WebSocket handler
app.ws('/sync', (ws, req) => {
  const clientId = req.query.clientId
  
  // Register client connection
  const disconnect = await remoteApi.connect({
    clientId,
    poke: () => {
      ws.send(JSON.stringify({ type: 'poke' }))
    }
  })
  
  ws.on('close', disconnect)
})
```

### Server-Sent Events Implementation

```typescript
// Server-side SSE handler
app.get('/events', (req, res) => {
  const clientId = req.query.clientId
  
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive'
  })
  
  const disconnect = await remoteApi.connect({
    clientId,
    poke: () => {
      res.write('data: {"type":"poke"}\\n\\n')
    }
  })
  
  req.on('close', disconnect)
})
```

## Choosing a Strategy

| Use Case | Recommended Strategy |
|----------|----------------------|
| Prototype/MVP | Reset |
| Small team app | Global Version |
| Multi-tenant SaaS | Per-Space Version |
| Large-scale production | Row Version |

## Security Considerations

### Authentication

```typescript
async push({ mutations, clientId }) {
  // Verify client authentication
  const user = await this.authenticate(clientId)
  if (!user) throw new Error('Unauthorized')
  
  // Apply mutations...
}
```

### Authorization

```typescript
async pull({ clientId, scanWindow }) {
  // Filter scan window by user permissions
  const user = await this.authenticate(clientId)
  const authorizedQueries = scanWindow.filter(query =>
    this.canUserRead(user, query)
  )
  
  // Build patch from authorized queries only
  const patch = await this.buildPatch(authorizedQueries)
  // ...
}
```

### Input Validation

```typescript
async push({ mutations, clientId }) {
  // Validate mutations before applying
  for (const mutation of mutations) {
    for (const op of mutation.ops) {
      if (op.type === 'set') {
        await this.validateRecord(op.value)
      }
    }
  }
  
  // Apply mutations...
}
```

## Testing Your Implementation

Use the provided `TestRemote` as a reference:

```typescript
import { TestRemote } from "tandem"

// Test your implementation against the reference
const testCases = [
  "syncs changes between clients",
  "handles concurrent modifications",
  "resolves conflicts correctly",
  "supports offline/online transitions"
]

for (const testCase of testCases) {
  await runTest(testCase, yourRemoteApi)
}
```

---

**Congratulations!** You now have a complete understanding of how to implement Tandem's remote sync API. Start with the Reset strategy for prototyping, then upgrade to more sophisticated approaches as your application scales.