## Test Conventions

### Sub-test comments

When a test contains multiple assertions that verify distinct behaviors, add a short comment before each logical sub-test explaining what it checks. Place the comment before the setup/transaction that leads to the assertion, not on the `expect` line itself.

```typescript
// Avoid: no comments separate logical sub-tests
const tx = client.transact()
tx.set("todos", todo("todo-1", { text: "Buy milk" }))
await (await client.commit(tx)).result
expect(result).toEqual([...])

subscription.destroy()
const anotherTx = client.transact()
anotherTx.set("todos", todo("todo-2", { text: "Quiet update" }))
await (await client.commit(anotherTx)).result
expect(result).toBeUndefined()

// Prefer: each sub-test is introduced with a comment
// Adding a todo updates the subscription result
const tx = client.transact()
tx.set("todos", todo("todo-1", { text: "Buy milk" }))
await (await client.commit(tx)).result
expect(result).toEqual([...])

// After unsubscribing, further commits don't trigger the callback
subscription.destroy()
const anotherTx = client.transact()
anotherTx.set("todos", todo("todo-2", { text: "Quiet update" }))
await (await client.commit(anotherTx)).result
expect(result).toBeUndefined()
```

### Transaction variable naming

Variables assigned from `.transact()` must either be named `tx` or end with the suffix `Tx`.

```typescript
// Avoid
const seed = client.transact()
const draft = client.transact()

// Prefer
const tx = client.transact()
const seedTx = client.transact()
```

### Fixtures

Use the `gatekeeper` fixture as the canonical Tandem driver. Access default clients through `gatekeeper.client1` and `gatekeeper.client2`; do not expose raw client fixtures. Await `CallHandle.result` when a call is expected to complete with gates inactive.

Define schema- or topology-specific fixtures in the spec that needs them with `test.extend(...)`. Register each `TandemClient` with Gatekeeper and expose the harness, not the concrete clients. `buildGatekeeperHarness`, `makeRemote`, and `makeStorage` provide shared construction and cleanup without placing application-specific schemas in `fixtures.ts`.

Fixture setup may initialize and connect concrete clients before calling `use`. Test bodies must drive Tandem through Gatekeeper proxies. This keeps server pokes independent from fixture setup calls while preserving controlled service boundaries for test actions.
