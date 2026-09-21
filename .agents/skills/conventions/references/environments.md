# Environments

Development, tests, examples, and production integrations should mount the same reusable library packages. What changes is the host: its configuration, capabilities, and how the run is controlled.

## Make startup explicit

Select host implementations and configuration at startup, not through environment branches throughout library code. In particular, avoid reading arguments, environment variables, files, or secrets merely by importing a reusable module:

```ts
export const config = await readConfig();
```

Prefer explicit invocation from the host's startup function:

```ts
async function startHost() {
  const config = await readConfig();
  if (config instanceof Error) return config;
  return await Server.start(config);
}
```

Tests and examples can construct the same service with their own configuration without changing global environment variables to make an import succeed.

## Give each development run its own home

Run real local versions of required services. Give each run isolated, Git-ignored databases, logs, and ports. Development tooling owns startup, readiness, inspection, and shutdown of its processes.

## Share host APIs with tests

Development commands and test fixtures use the same programmatic construction and control APIs. Fixtures call those APIs directly; they do not shell out to development commands, and development commands do not depend on a test runner.

Use Turborepo for dependency-aware builds and affected checks. Keep static checks and consumer E2Es separately runnable; run focused E2Es during iteration rather than automatically starting every example.

## Deploy in dependency order

Production hosts use the same adapters as local hosts with different configuration. Deploy required schema changes first, then backends from lowest to highest layer, then clients. Keep migration and rollout details in the project's release plan.
