# Implement Feature/Fix Spec Sheet

You are tasked with implementing a feature/fix based on a provided spec sheet. Follow the implementation process below systematically.

## Implementation Process

1. **Read and analyze the spec**: Understand the problem, solution, and all implementation tasks
2. **Plan with todos**: Use `todo_write` to create a comprehensive todo list from the spec's checkbox items
3. **Implement systematically**: Work through each todo item in logical order, marking them as in-progress and completed
4. **Quality assurance**: Complete the Code Quality section tasks as specified in the spec
5. **Verify completion**: Ensure all spec requirements are met

## Implementation Guidelines

### Code Quality Standards

- **ALWAYS** run `get_diagnostics` on edited files to check for errors
- **CRITICAL**: Do not introduce any new errors or warnings from your code
- Follow all patterns and conventions documented in AGENT.md
- Use existing libraries, utilities, and patterns from the codebase
- Maintain consistent code style with surrounding code

### Tool Usage Strategy

- Use `codebase_search_agent` to understand existing implementations before making changes
- Use `Read` to examine files before editing them
- Use `Grep` to find related code patterns and references
- Use `edit_file` for targeted changes, `create_file` for new files
- Use `format_file` after making significant edits
- Use `get_diagnostics` to verify changes don't introduce errors
- Use `Task` (sub-agents) wherever possible to implement independent tasks in parallel and handle complex multi-step implementations efficiently

### Task Management

- Use `todo_write` to track all spec items at the start
- Mark todos as "in-progress" when starting work on them
- Mark todos as "completed" immediately after finishing each one
- Update todo status frequently to show progress
- Don't batch multiple completions - mark each todo as done when finished

### Implementation Order

1. **Database/Schema changes first**: Update core data structures
2. **API/Backend changes**: Update server-side logic and contracts
3. **Frontend changes**: Update UI components and client-side logic
4. **Integration testing**: Verify all pieces work together
5. **Code quality verification**: Run all quality checks as specified

### Error Handling

- If you encounter errors during implementation, analyze them carefully
- Use `codebase_search_agent` to understand how similar issues are handled
- Fix errors before proceeding to the next task
- Update the todo list if you discover additional required tasks

### Communication

- Provide brief updates on progress without excessive explanation
- Focus on completing tasks rather than explaining what you're doing
- Report any blockers or issues that require clarification
- Summarize completion when all tasks are done

## Before Starting

1. Confirm you have access to the spec sheet to implement
2. Read the entire spec to understand the scope
3. Ask for clarification if any requirements are ambiguous
4. Check AGENT.md for any specific guidelines related to the feature area

## Success Criteria

- All checkbox items in the spec are completed
- All Code Quality section tasks pass successfully
- No new errors or warnings introduced
- All existing functionality continues to work
- Implementation follows existing code patterns and conventions

SPEC FILE TO IMPLEMENT:
