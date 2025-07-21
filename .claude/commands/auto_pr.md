# Auto PR Command

Automatically creates a GitHub pull request for the current branch using the `gh` CLI.

## Usage

Run this command when you have commits on a feature branch and want to create a PR to merge into the main branch.

## Process

1. **Check Git Status**: Verify current branch and commit status
2. **Analyze Changes**: Review commits and changes since diverging from main branch
3. **Generate PR Content**: Create title and description based on commit history
4. **Push Branch**: Ensure branch is pushed to remote with tracking
5. **Create PR**: Use `gh pr create` with generated content

## What This Command Does

- Analyzes git log and diff to understand the changes made
- Generates an appropriate PR title based on the commit messages
- Creates a comprehensive PR description with:
  - Summary of changes (bullet points)
  - Test plan with actionable items
  - Proper formatting for GitHub

## Requirements

- `gh` CLI must be installed and authenticated
- Current branch should have commits different from main
- Repository must be a GitHub repository

## Example Output

Creates a PR with format like:
```
Title: feat: restructure monorepo with src folders and fix ESLint config

Body:
## Summary
• Move source code to src/ folders for better organization
• Fix ESLint configuration to use modern flat config format
• Update package.json and tsconfig.json for new structure
```

The command handles the entire PR creation workflow automatically, ensuring proper formatting and comprehensive descriptions.