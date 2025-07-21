# Code Review Guidelines

You are reviewing code changes for Tandem, a sync engine and database for collaborative applications. 

## Getting Changed Files

1. Stage all existing changes: `git add .`
2. Find changed files: `git diff --name-only main HEAD`

Check all changed files against these rules:

## Code Quality

- [ ] **TypeScript Strict**: No `any` types, proper generic constraints, strict null checks
- [ ] **ESLint Compliance**: Follows configured rules including no-floating-promises, unused-vars with underscore prefix
- [ ] **Imports**: Uses named exports, proper import organization, no circular dependencies  
- [ ] **Error Handling**: Async operations handle errors appropriately, no unhandled promise rejections

## Tandem-Specific Patterns

- [ ] **Tuple Storage**: Data operations use tuple format `["record", collection, id]` consistently
- [ ] **Query Builder**: Query operations use `q.Collection.select()` pattern and type-safe where clauses
- [ ] **Transactions**: Database modifications use `db.transact()` � `tx.set()` � `db.commit()` pattern

## Testing & Documentation

- [ ] **Test Coverage**: New functionality includes `.test.ts` files with Vitest
- [ ] **Test Isolation**: Uses `isolate: false` pattern, proper beforeEach cleanup
- [ ] **JSDoc Comments**: Public APIs have proper documentation, private methods avoid unnecessary comments
- [ ] **CLAUDE.md Updates**: Significant changes update the architecture documentation

## Performance & Reliability

- [ ] **Async Patterns**: Proper Promise handling, uses `await` not `.then()`, handles concurrent operations
- [ ] **Memory Management**: Subscriptions are unsubscribed, resources cleaned up properly
- [ ] **Logging**: Uses provided LoggerApi for debugging, not console.log
- [ ] **ID Generation**: Uses provided RngApi for IDs, follows existing randomId patterns

## Security & Data Integrity

- [ ] **Input Validation**: Query parameters and user data validated before storage operations
- [ ] **Schema Conformance**: All data operations respect defined Schema types and constraints
- [ ] **Sync Integrity**: Changes maintain data consistency across clients during sync operations
- [ ] **Storage Security**: No direct IndexedDB access bypassing the Storage layer

Check each file against relevant rules. Flag violations with specific examples and suggest fixes that align with existing codebase patterns.