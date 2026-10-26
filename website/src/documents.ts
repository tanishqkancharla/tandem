import { notFound } from "@tanstack/react-router"

export const docSections = [
	{
		title: "Get started",
		pages: [
			{ slug: "overview", title: "Overview" },
			{ slug: "quickstart", title: "Quickstart" },
		],
	},
	{
		title: "Guides",
		pages: [
			{ slug: "queries", title: "Queries" },
			{ slug: "server", title: "Server" },
			{ slug: "agent-chat", title: "Agent chat" },
		],
	},
	{
		title: "Concepts",
		pages: [
			{ slug: "sync", title: "How sync works" },
			{ slug: "custom-remote", title: "Custom remotes" },
		],
	},
	{
		title: "Project",
		pages: [
			{ slug: "roadmap", title: "Roadmap" },
			{ slug: "design/relational-queries", title: "Relational queries design" },
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
