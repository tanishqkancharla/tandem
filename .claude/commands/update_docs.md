# Update CLAUDE.md Documentation

Analyze all files changed in this branch compared to main and automatically update any potentially affected CLAUDE.md documentation files.

## Instructions

1. **Review branch changes**: Use `git diff main...HEAD` to examine all files changed in this branch compared to main
2. **Identify affected directories**: Find all packages, apps, and subdirectories that contain modified files
3. **Locate CLAUDE.md files**: For each affected directory, check if it contains a CLAUDE.md file or if the docs folder has files that might need updates
4. **Analyze impact**: Determine what aspects of the documentation might be outdated based on the code changes:
   - New functions, APIs, or components
   - Changed usage patterns or interfaces
   - Modified build/test/deployment commands
   - Updated code conventions or patterns
   - New major pieces or architectural changes
5. **Update documentation**: Modify the relevant CLAUDE.md and docs folder files to reflect the changes, following the Writing Guidelines section below

## Expected Output

- List of CLAUDE.md and docs files that were updated
- Brief summary of what changes were made to each file
- Confirmation that documentation now reflects the branch changes

## Package Structure Reference

```
<project>/
├── CLAUDE.md          # Development guidance
└── docs/              # Documentation folder
    └── *.md           # Specific documentation files
```

## Writing Guidelines

When updating CLAUDE.md and docs files, follow these principles:

- **Focus on what's unique to this project**: Avoid duplicating content between files
- **Use relative file paths**: Reference files as `src/index.ts` not absolute paths
- **Link to docs folder files**: For specific functionality details
- **Include working code samples**: When relevant for understanding usage
- **Keep sections structured**:
  - **What the code does**: Clear description of purpose
  - **How to use the code**: Basic usage patterns and key APIs
  - **How to write/edit code**: Project-specific patterns and conventions
  - **Major pieces**: Key components with links to relevant docs

Start by running `git diff main...HEAD` to see what changes are in this branch compared to main.
