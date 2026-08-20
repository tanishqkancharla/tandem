## Test Conventions

### Sub-test comments

When a test contains multiple assertions that verify distinct behaviors, add a short comment before each logical sub-test explaining what it checks. Place the comment before the setup/transaction that leads to the assertion, not on the `expect` line itself.

```typescript
// ❌ Bad — no comments separating logical sub-tests
const tx = client.transact()
tx.set("todos", todo("todo-1", { text: "Buy milk" }))
await client.commit(tx)
expect(result).toEqual([...])

subscription.destroy()
const anotherTx = client.transact()
anotherTx.set("todos", todo("todo-2", { text: "Quiet update" }))
await client.commit(anotherTx)
expect(result).toBeUndefined()

// ✅ Good — each sub-test is introduced with a comment
// Adding a todo updates the subscription result
const tx = client.transact()
tx.set("todos", todo("todo-1", { text: "Buy milk" }))
await client.commit(tx)
expect(result).toEqual([...])

// After unsubscribing, further commits don't trigger the callback
subscription.destroy()
const anotherTx = client.transact()
anotherTx.set("todos", todo("todo-2", { text: "Quiet update" }))
await client.commit(anotherTx)
expect(result).toBeUndefined()
```

### Transaction variable naming

Variables assigned from `.transact()` must either be named `tx` or end with the suffix `Tx`.

```typescript
// ❌ Bad
const seed = client.transact()
const draft = client.transact()

// ✅ Good
const tx = client.transact()
const seedTx = client.transact()
```

### Fixtures

Use the Vitest fixtures from `./fixtures` instead of constructing `TandemClient`, remotes, or IndexedDB storage in the test body. Fixtures disconnect clients, destroy remotes, and close/clear storage after the test.

- `client1` / `client2` — connected todo-schema clients sharing `server`
- `threadClient` — local relational client with no remote
- `threadClients` — two connected relational clients sharing a remote
- `server` / `threadServer` — in-memory remotes constructed in the fixture
- `makeClient` — extra clients with custom schema, remote, or `storage: { dbName }`; disconnect and IndexedDB cleanup happen after the test
