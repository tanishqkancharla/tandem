# Sync Engine

## What

Handles real-time synchronization between local database and remote server. Manages optimistic updates, conflict resolution, and ensures data consistency.

## How to use

```typescript
// Configured automatically by TandemClient
const remote = {
	async push(mutations) {
		// Send mutations to server
	},
	async pull({ cookie, scanWindow }) {
		// Fetch updates from server
		return { cookie, patch, lastMutationId };
	},
	async connect(api) {
		// Real-time connection for pokes
	},
};
```

## How it works

1. **Optimistic Updates**: Apply changes locally first
2. **Push**: Stream mutations to server
3. **Pull**: Fetch server updates via scan windows
4. **Conflict Resolution**: Rollback → apply server patch → replay local changes
5. **Poke System**: Real-time notifications from server

## Key patterns

**Implement remote API:**

```typescript
const remote = {
  async sync(mutations) {
    // Return conflicts for resolution
    return { conflicts: [...], resolved: [...] };
  }
};
```

**Handle rollbacks:**

```typescript
// Automatically handled by sync engine
// Rollback conflicting optimistic updates
// Re-apply non-conflicting changes
```
