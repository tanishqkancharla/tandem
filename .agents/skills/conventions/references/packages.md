# Packages

A package gives consumers a cohesive API. Its boundary should explain what they can use without making them understand how the code is organized inside.

## Decide whether a new package earns its place

Create packages for cohesive consumer contracts. Do not extract a package merely to share a few lines or make an internal test qualify as an E2E. Use a dependency directly when it already supplies the needed abstraction.

For example, a wrapper that only forwards another library call adds no independent contract:

```ts
// Avoid: a separate package that only renames a dependency call.
export function createStore(options: StoreOptions) {
  return dependency.createStore(options);
}

// Prefer: the owning service uses the dependency directly.
const store = dependency.createStore(options);
```

The owning service still controls lifetime, configuration, error conversion, and persistence. Using the dependency directly does not remove that ownership.

## Put it in the right layer

Use pnpm workspaces and Turborepo. Name published packages with the `@tanishqkancharla/tandem-*` prefix. Keep reusable libraries in `packages/` and runnable consumer examples in `examples/`. Examples may depend on packages; publishable packages do not depend on example internals. Keep dependencies acyclic.

## Expose the contract, not the file tree

Each package has one supported main entry, not necessarily one exported symbol. Consumers import that public API rather than internal files. Document runtime-separated export exceptions when combining environments would load incompatible dependencies.

Reserve `index.ts` for a package's actual main export file. Do not add `index.ts` barrels inside package subdirectories; import the owning module directly so dependency paths identify the implementation that owns the contract.

Inside the package, organize files around service ownership. Keep a service, its helpers, and its types together. Put shared children at the lowest common owner that needs them. Split by responsibility, not file length.
