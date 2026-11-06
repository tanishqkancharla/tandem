import { notFound } from "@tanstack/react-router"

export const docSections = [
	{
		title: "Start here",
		pages: [
			{ slug: "overview", title: "Overview" },
			{ slug: "quickstart", title: "Quickstart" },
			{ slug: "sync", title: "How sync works" },
		],
	},
	{
		title: "How-to guides",
		pages: [
			{ slug: "agent-chat", title: "Build streaming chat" },
			{
				slug: "existing-api-server",
				title: "Add Tandem to an existing API server",
			},
			{ slug: "cloudflare", title: "Deploy on Cloudflare" },
		],
	},
	{
		title: "Storage adapters",
		pages: [
			{ slug: "sql", title: "Choosing storage" },
			{ slug: "storage/postgresql", title: "PostgreSQL" },
			{ slug: "storage/mysql", title: "MySQL" },
			{ slug: "storage/d1", title: "Cloudflare D1" },
			{ slug: "storage/json-file", title: "JSON file" },
			{ slug: "storage/custom", title: "Custom storage adapters" },
		],
	},
	{
		title: "API reference",
		pages: [
			{ slug: "client", title: "Client" },
			{ slug: "queries", title: "Queries" },
			{ slug: "mutations", title: "Mutations" },
			{ slug: "server", title: "Server" },
		],
	},
	{
		title: "Application responsibilities",
		pages: [
			{ slug: "permissions", title: "Authentication and permissions" },
			{ slug: "migrations", title: "Schema changes and client compatibility" },
		],
	},
]

export const docPages = docSections.flatMap((section) => section.pages)

const sources = import.meta.glob<string>("../../docs/**/*.md", {
	query: "?raw",
	import: "default",
})

export async function loadDocument(slug: string) {
	const page = docPages.find((page) => page.slug === slug)
	const load = sources[`../../docs/${slug}.md`]
	if (!page || !load) throw notFound()
	return { ...page, markdown: await load() }
}

export type Document = Awaited<ReturnType<typeof loadDocument>>

export function documentHref(href: string, slug: string) {
	if (href.startsWith("#") || /^[a-z][a-z\d+.-]*:/i.test(href)) return href
	const url = new URL(href, `https://tandem.invalid/docs/${slug}.md`)
	const target = url.pathname.slice("/docs/".length).replace(/\.md$/, "")
	if (url.pathname === "/docs/README.md") return `/docs${url.hash}`
	if (
		url.pathname.startsWith("/docs/") &&
		docPages.some((page) => page.slug === target)
	) {
		return `/docs/${target}${url.hash}`
	}
	return `https://github.com/tanishqkancharla/tandem/tree/main${url.pathname}${url.hash}`
}
