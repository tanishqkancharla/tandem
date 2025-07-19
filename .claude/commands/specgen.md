# Generate Feature/Fix Spec Sheet

Create a spec sheet for the given feature/fix request in specs/ directory.

Follow this format and structure:

1. **Title**: Clear, action-oriented title matching the request
2. **Introduction**: Brief description of what the spec outlines
3. **Problem section**: Explain the current issue/limitation (if applicable)
4. **Solution section**: High-level approach to address the problem
5. **Implementation sections**: Break down by affected areas (e.g., Backend API, Frontend, Database Schema, etc.)
   - Use hierarchical checkbox format `- [ ]` for all tasks
   - Each file edit should have a single descriptive todo
   - Include specific file paths and method names where applicable
   - Nest sub-tasks under main tasks using indentation
   - Focus on concrete, actionable implementation steps
   - Use descriptive titles for task groups instead of section headings
6. **Code Quality section**: Standard quality assurance tasks (exactly as shown below)
   ```md
   - [ ] Run `pnpm type-check` to ensure all TypeScript types are correct
   - [ ] Run `pnpm build` to ensure all packages compile successfully
   - [ ] Run `pnpm lint` to verify no linting errors
   - [ ] Ensure all written code adheres to the quality documentation in AGENT.md
   - [ ] Update this spec to mark all tasks as completed
   ```

## Task Structure Guidelines

Each todo heading should be a todo itself and a full sentence summarizing the sub-todos.

DON'T DO THIS:

```
#### RPC Handler Updates
- [ ] Remove `globalTaskContext` and `user` collection handling from [`apps/api/src/rpc.ts`](apps/api/src/rpc.ts)
- [ ] Remove any server-side logic for global task context synchronization
- [ ] Remove any server-side user data storage or retrieval logic
```

DO THIS:

```
- [ ] Update RPC handlers to remove any usage of globalTaskContext and user client-side collections.
  - [ ] Remove `globalTaskContext` and `user` collection handling from [`apps/api/src/rpc.ts`](apps/api/src/rpc.ts)
  - [ ] Remove any server-side logic for global task context synchronization
  - [ ] Remove any server-side user data storage or retrieval logic
```

## Writing Effective Specs

Keep specs focused and practical by following these principles:

**Focus on core functionality**: Define what needs to be done and why, but avoid over-engineering. Don't include every possible enhancement or edge case unless it's critical to solving the main problem. The spec should ideally be around 60-70 lines of code. Really avoid going over 100. If you find yourself doing so, go back through the spec and ask if yourself if each todo is really essential.

**Avoid over-specification**: Don't prescribe every implementation detail. Let the development team decide specific UI patterns, interaction behaviors, and technical approaches during implementation.

**Streamline tasks**: Group related work into logical sections with clear, actionable tasks. Remove redundant or overly granular sub-tasks that could be decided during development.

**Essential over exhaustive**: Resist the urge to include "nice-to-have" features like accessibility improvements, mobile optimization, or advanced user experience enhancements unless they're directly related to the core problem.

## What to avoid in the spec

- Avoid any mobile code
- Avoid creating new UI components unless absolutely necessary to the core functionality. Use design system components as much as possible.

Before writing the spec, analyze the codebase to understand the current implementation and identify which packages/apps will be affected. If you are confused or need clarification (e.g. if there are multiple possible meanings to the user's request), then ask the user the necessary follow-up questions. Don't ask follow-ups if they aren't required.

FEATURE REQUEST:
