## Test Conventions

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
