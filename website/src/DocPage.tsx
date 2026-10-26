import { Link } from "@tanstack/react-router"
import { Code, CodeBlock, MermaidDiagram, Text, proseHtml } from "maui"
import { useStyles } from "purse-styles"
import { isValidElement } from "react"
import Markdown from "react-markdown"
import rehypeSlug from "rehype-slug"
import remarkGfm from "remark-gfm"
import { docPages, documentHref, type Document } from "./documents.js"

export function DocPage({ document }: { document: Document }) {
	const proseClass = useStyles(proseHtml("md"))
	const index = docPages.findIndex((page) => page.slug === document.slug)
	const previous = docPages[index - 1]
	const next = docPages[index + 1]
	return (
		<article className="doc-page">
			<div className="doc-eyebrow">
				<Text size="xs" color="lowContrast">
					Tandem / Documentation
				</Text>
			</div>
			<div className={`markdown ${proseClass}`}>
				<Markdown
					remarkPlugins={[remarkGfm]}
					rehypePlugins={[rehypeSlug]}
					components={{
						a: ({ href, children }) => (
							<a href={documentHref(href ?? "", document.slug)}>{children}</a>
						),
						code: ({ className, children }) =>
							className ? (
								<code className={className}>{children}</code>
							) : (
								<Code>{String(children)}</Code>
							),
						pre: ({ children }) => {
							if (
								!isValidElement<{ className?: string; children?: string }>(
									children,
								)
							)
								return <pre>{children}</pre>
							const lang =
								children.props.className?.replace("language-", "") ?? "text"
							const source = String(children.props.children).replace(/\n$/, "")
							return lang === "mermaid" ? (
								<MermaidDiagram source={source} />
							) : (
								<CodeBlock lang={lang}>{source}</CodeBlock>
							)
						},
						table: ({ children }) => (
							<div className="table-scroll">
								<table>{children}</table>
							</div>
						),
					}}
				>
					{document.markdown}
				</Markdown>
			</div>
			<div className="doc-edit">
				<a
					href={`https://github.com/tanishqkancharla/tandem/edit/main/docs/${document.slug}.md`}
				>
					Edit this page on GitHub ↗
				</a>
			</div>
			<nav className="doc-pagination" aria-label="Previous and next pages">
				<div>
					{previous && (
						<Link to="/docs/$" params={{ _splat: previous.slug }}>
							<Text size="xs" color="lowContrast">
								Previous
							</Text>
							<Text size="sm">← {previous.title}</Text>
						</Link>
					)}
				</div>
				<div>
					{next && (
						<Link to="/docs/$" params={{ _splat: next.slug }}>
							<Text size="xs" color="lowContrast">
								Next
							</Text>
							<Text size="sm">{next.title} →</Text>
						</Link>
					)}
				</div>
			</nav>
		</article>
	)
}
