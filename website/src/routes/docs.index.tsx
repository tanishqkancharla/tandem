import { createFileRoute } from "@tanstack/react-router"
import { DocPage } from "../DocPage.js"
import { loadDocument } from "../documents.js"

export const Route = createFileRoute("/docs/")({
	loader: () => loadDocument("overview"),
	head: () => ({ meta: [{ title: "Overview — Tandem docs" }] }),
	component: () => <DocPage document={Route.useLoaderData()} />,
})
