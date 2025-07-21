# Convert Tandem Library to pnpm/Turborepo Monorepo

## Introduction

This spec outlines the conversion of the Tandem sync engine library from a single package into a well-structured monorepo using pnpm workspaces and Turborepo for build orchestration, following patterns established by the Triplit repository.

## Problem

The current Tandem library is structured as a single package, which limits modularity and makes it difficult to:

- Separate core functionality from framework-specific integrations
- Provide targeted packages for different use cases (client-only, server-only, etc.)
- Enable independent versioning and publishing of different components
- Allow for better tree-shaking and bundle size optimization for consumers

## Solution

Convert the library into a monorepo with the following package structure:
- `@tandem/core`: Core sync engine and database functionality
- `@tandem/client`: Browser-focused client package
- `@tandem/types`: Shared TypeScript types
- `@tandem/testing`: Testing utilities and test remote implementation

## Implementation

- [x] Set up monorepo infrastructure with pnpm workspaces and Turborepo configuration
  - [x] Create root `pnpm-workspace.yaml` to define workspace packages
  - [x] Update root `package.json` with workspace scripts and turborepo dependency
  - [x] Create `turbo.json` configuration for build orchestration
  - [x] Set up shared tooling configuration (ESLint, TypeScript, Prettier)

- [x] Create `@tandem/core` package containing the main sync engine functionality
  - [x] Create `packages/core/` directory structure
  - [x] Move core files: `Database.ts`, `TandemClient.ts`, `sync/`, `transaction/`, `storage/`, `utils/`
  - [x] Create `packages/core/package.json` with appropriate dependencies
  - [x] Set up `packages/core/tsconfig.json` extending root configuration
  - [x] Update imports and exports for the core package

- [x] Create `@tandem/client` package for browser-optimized client functionality
  - [x] Create `packages/client/` directory structure
  - [x] Move IndexedDB-specific code and browser optimizations
  - [x] Create `packages/client/package.json` depending on `@tandem/core`
  - [x] Set up browser-specific build configuration

- [x] Create `@tandem/types` package for shared TypeScript definitions
  - [x] Create `packages/types/` directory structure
  - [x] Move `types.ts` and other shared type definitions
  - [x] Create `packages/types/package.json` as a pure types package
  - [x] Update other packages to depend on `@tandem/types`

- [x] Create `@tandem/testing` package for test utilities
  - [x] Create `packages/testing/` directory structure
  - [x] Move `TestRemote.ts` and other testing utilities
  - [x] Create `packages/testing/package.json` with appropriate dev dependencies
  - [x] Set up testing package for internal use only

- [x] Update root configuration files for monorepo structure
  - [x] Modify root `tsconfig.json` to use project references
  - [x] Update `eslint.config.mjs` for workspace linting
  - [x] Adjust `vitest.config.js` for workspace testing
  - [x] Update `.gitignore` for monorepo patterns

- [x] Migrate build and development scripts to use Turborepo
  - [x] Update build processes to work across packages
  - [x] Set up parallel development workflows
  - [x] Configure package interdependencies in turbo.json
  - [x] Ensure proper build ordering and caching

- [ ] Update documentation and examples for the new package structure
  - [ ] Update `README.md` with monorepo usage instructions
  - [ ] Modify `docs/quickstart.md` to reflect new import paths
  - [ ] Update `CLAUDE.md` with new development commands and structure

## Code Quality

- [x] Run `pnpm type-check` to ensure all TypeScript types are correct
- [x] Run `pnpm build` to ensure all packages compile successfully
- [x] Run `pnpm lint` to verify no linting errors
- [x] Ensure all written code adheres to the quality documentation in AGENT.md
- [x] Update this spec to mark all tasks as completed