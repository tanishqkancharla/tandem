---
name: conventions
description: Apply Tandem repository design conventions when writing, refactoring, or reviewing TypeScript packages, services, state, dependencies, environments, or tests.
---

# Repository conventions

Keep behavior reusable across consumers and environments. Give state, dependencies, and lifecycle explicit owners. Prefer composition and direct consumer flows over layers that send work back and forth.

## Find the relevant page

Read the pages relevant to the change before editing:

| When changing                                                 | Read                                       |
| ------------------------------------------------------------- | ------------------------------------------ |
| Package boundaries, exports, or file organization             | [Packages](references/packages.md)         |
| Services, host interfaces, startup, cleanup, or client access | [Services](references/services.md)         |
| Mutable state, streams, derived views, or operation ordering  | [State](references/state.md)               |
| TypeScript implementation or error handling                   | [TypeScript](references/typescript.md)     |
| Tests, fixtures, or test review                               | [Testing](../testing/SKILL.md)              |
| Development hosts, environment setup, CI, or deployment       | [Environments](references/environments.md) |
| Dependency upgrades and resulting cleanup                     | [Dependencies](references/dependencies.md) |

Read multiple pages when a change crosses boundaries, not the entire handbook for every task. Package-level `AGENTS.md` files refine these conventions for their scope.

Examples use simplified TypeScript adapted from real code, not complete implementations. Imports and unrelated setup are omitted; “avoid” shows the counterexample, and “prefer” shows the intended shape.

## Apply it to the change at hand

Apply these principles practically. Improve the changed area without turning a small task into a full migration. Do not add wrappers, packages, or tests merely to satisfy a diagram. Garden locally: fix small stale guidance, misleading comments, dead code, and confusing APIs exposed by the work, but leave larger or separate improvements as scoped follow-ups. Keep project commands and agent-specific instructions in `AGENTS.md`, and keep current architecture and migration progress in implementation specs. Update the relevant spec as work lands; do not describe planned APIs as available.
