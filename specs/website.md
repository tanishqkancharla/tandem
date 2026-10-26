# Tandem website

## Problem

Tandem has Markdown guides in `docs/`, but no website or browser documentation. Add a minimal home page inspired by Halo and a Maui-styled documentation reader without duplicating those guides.

## Solution

`website/` is a private pnpm workspace using TanStack Start, React, and Maui. `/` introduces Tandem; `/docs` shows the overview; `/docs/<slug>` loads the corresponding Markdown guide. Maui 0.0.62 requires browser APIs during rendering, so Start builds a static SPA shell and mounts Maui client-side.

```diagram
┌──────────────┐     ┌──────────────────┐     ┌────────────────┐
│ docs/*.md    │────▶│ Vite raw imports │────▶│ Maui doc reader│
└──────────────┘     └──────────────────┘     └────────────────┘
```

## Goals and non-goals

Match Halo's narrow 80ch column, responsive inset, single-sentence introduction, and compact action. Use Maui's `Button` components for GitHub (quiet, with GitHub's Octicons mark and a live public star count, without a star icon), Docs (default, rightmost), and Get started (primary), with Maui's native cursor, focus, and label handling. The star count loads independently; unavailable counts show a dash without blocking navigation. Use `Prose` and `P` for the introduction. Keep navigation at the top right, with no feature block or footer. Preserve existing Markdown content, relative links, heading anchors, tables, highlighted code, and diagrams. Support narrow screens, theme selection, and filtering page titles. Do not change Tandem's database behavior, purchase a domain, or deploy the site.

## Implementation

### Phase 1: Website and documentation scaffold

Today: Guides are read in the repository. There is no website workspace.

Proposed: Add a Start website with one documentation catalog, a shared reader, and Maui controls. Existing guides remain the content source.

Implemented locally; changes are uncommitted. The route loaders share [[website/src/documents.ts#loadDocument]], and [[website/src/DocPage.tsx#DocPage]] renders the result.

```changes
```

```callstack
+getRouter # mount home and documentation routes [[website/src/router.tsx#getRouter]]
+├── Home # show the product description and docs link [[website/src/routes/index.tsx#Home]]
+└── DocsLayout # filter and navigate guide titles [[website/src/routes/docs.tsx#DocsLayout]]
+    ├── loadDocument # import the selected Markdown file [[website/src/documents.ts#loadDocument]]
+    └── DocPage # render prose, code, diagrams, and pagination [[website/src/DocPage.tsx#DocPage]]
```

The catalog pairs a path with a display title. The loaded document adds the original Markdown; unknown paths use the router's not-found handling.

```tsx
type Document = { slug: string; title: string; markdown: string }

async function renderGuide(slug: string) {
	const document = await loadDocument(slug)
	return <DocPage document={document} />
}

const visiblePages = pages.filter((page) =>
	page.title.toLowerCase().includes(search.toLowerCase()),
)
// Relative guide links stay on the website; source links open GitHub.
const href = documentHref(markdownHref, currentSlug)
```

[[website/e2e/website.spec.ts]] exercises navigation, relative and nested links, anchors, code, diagrams, tables, deep-link reloads, unknown pages, filtering, narrow navigation, and persisted themes. Production builds emit `dist/client/_shell.html`; the Vercel configuration serves assets and rewrites deep links to that shell. Full SSR remains blocked by Maui's provider initialization.

### Phase 2: Holocron documentation site

Today: The Start app includes a custom Maui documentation reader alongside the homepage.

Proposed: Run the existing Markdown as a Holocron docs site, using its built-in article layout, navigation, diagrams, syntax highlighting, and themes. Keep the Maui homepage unchanged.

Implemented locally, not published. [[docs/vite.config.ts]] installs the Holocron Vite plugin; [[docs/docs.json]] lists the nine guides. No guide content is copied. Repository source links use absolute GitHub URLs because Holocron validates links within the documentation root.

```diagram
┌─────────────┐     ┌────────────────┐     ┌──────────────────┐
│ docs/*.md   │────▶│ Holocron Vite  │────▶│ Node docs server │
│ docs.json   │     │ build          │     │ + browser assets │
└─────────────┘     └────────────────┘     └──────────────────┘
```

The plugin owns routing and rendering. Its production entry point is `docs/dist/rsc/index.js`; the development server uses port 3100.

```callstack
+defineConfig [[docs/vite.config.ts]]
+└── holocron # compile guides and provide the docs application
```

```tsx
// Holocron handles this flow; Tandem supplies content and navigation.
const page = markdownFiles.find((page) => page.slug === request.path)
return <HolocronArticle page={page} navigation={docsConfig.navigation} />
```

The assistant is disabled until an AI service is configured. Sidebar search filters page titles. Hosting and the final docs URL are not configured, so the homepage still links to the existing `/docs` reader. Publishing and switching those links remain pending.

Validation: the Holocron build, type-check, lint, and frozen-lockfile install pass. The production Node server returns HTTP 200 for all nine pages, Markdown exports, and the local wordmark; `docs.zip` contains nine guides. Browser checks cover rendered diagrams, highlighted code, nested links, heading anchors, dark mode, and narrow navigation with no horizontal overflow. The homepage's two E2E tests pass on rerun after an initial navigation timeout. Holocron emits development dependency-optimization warnings under pnpm and a production chunk-size warning; neither blocked these checks.

### Phase 3: Beautiful Mermaid renderer

Today: Holocron's Mermaid component loads Mermaid.js in a browser effect and re-renders the SVG on theme changes.

Proposed: Patch that component to use `beautiful-mermaid`, preserving the Markdown fences and source-code fallback.

Implemented locally in [[patches/@holocron.so__vite@0.38.0.patch]]. The version-specific pnpm patch changes Holocron's source and compiled component, plus its dependency optimizer. [[pnpm-workspace.yaml]] registers the patch and adds `beautiful-mermaid` and `errore` to Holocron's runtime dependencies.

```callstack
 Mermaid
-└── mermaid.render # render in a browser effect after initializing the theme
+└── renderMermaidSVG # render synchronously with the site's CSS palette
```

The SVG inherits the site's background and foreground. Every palette slot is mapped explicitly because Holocron's `--accent` and `--muted` mean background colors, while Beautiful Mermaid uses those names for foreground details. Wide diagrams scroll within a focusable region rather than shrinking below a 640px layout width; naturally smaller diagrams keep their size.

```tsx
const svg = useMemo(() => renderMermaidSVG(chart, sitePalette), [chart])
return <Diagram role="region" tabIndex={0} svg={svg} />
```

The production build and frozen-lockfile install pass. Browser validation checks both existing diagram types, every expected node/message label, live light/dark color changes, persisted dark mode, and keyboard horizontal scrolling at 390px without page overflow. Both diagrams are present in the server-rendered HTML; the browser reports no uncaught errors. The Maui homepage and its existing reader are unchanged by this patch.

## References

- [TanStack Start setup](https://tanstack.com/start/latest/docs/framework/react/build-from-scratch)
- [TanStack Start SPA mode](https://tanstack.com/start/latest/docs/framework/react/guide/spa-mode)
- [Halo](https://gethalo.dev/)
- [Maui](https://maui.tanishqkancharla.dev/)
- [Holocron](https://holocron.so/docs)
- [[docs/README.md]]
- [[website/README.md]]
