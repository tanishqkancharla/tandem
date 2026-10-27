import { createFileRoute } from "@tanstack/react-router"
import { DocPage } from "../DocPage.js"
import { loadDocument } from "../documents.js"

export const Route = createFileRoute("/docs/$")({
	loader: ({ params }) => loadDocument(params._splat ?? "overview"),
	head: ({ loaderData }) => ({
		meta: [{ title: `${loaderData?.title ?? "Page not found"} — Tandem docs` }],
	}),
	component: () => <DocPage document={Route.useLoaderData()} />,
})
