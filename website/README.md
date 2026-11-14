# Tandem website

TanStack Start + React + Maui. The site has one page, the home page at `/`. Documentation lives in the Holocron site under [`docs/`](../docs/README.md); `/docs` and `/docs/<page>` redirect there.

The homepage runs at [tandemsync.dev](https://tandemsync.dev). Its Docs link opens the Holocron site at [docs.tandemsync.dev](https://docs.tandemsync.dev). Its main button copies a prompt that tells a coding agent to follow [`public/setup.md`](public/setup.md), served at [tandemsync.dev/setup.md](https://tandemsync.dev/setup.md).

Run from the repository root:

```sh
pnpm install
pnpm --filter @tandem/website dev
pnpm --filter @tandem/website build
pnpm --filter @tandem/website preview
pnpm --filter @tandem/website type-check
pnpm --filter @tandem/website lint
pnpm --filter @tandem/website test:e2e
```

The development and preview servers use port 3000. In an Amp orb, expose the development server with:

```sh
amp orb service start tandem-website --command 'pnpm --filter @tandem/website dev' --port 3000 --portal
```

## Rendering and hosting

Maui 0.0.62 reads `window.matchMedia` during provider initialization. The site therefore uses TanStack Start's SPA mode and mounts Maui inside `ClientOnly`. Page content requires JavaScript; the build prerenders a static shell. Full SSR and prerendered page content need SSR-compatible Maui providers.

`pnpm --filter @tandem/website build` writes static files to `website/dist/client`. Serve existing assets normally, redirect `/docs` paths to docs.tandemsync.dev, and rewrite other paths to `/_shell.html`. `website/vercel.json` supplies this configuration. The Vercel project `tandem-website` uses `website` as its root directory and runs Node.js 22.
