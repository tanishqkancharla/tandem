import {
	Link,
	Outlet,
	createFileRoute,
	useLocation,
} from "@tanstack/react-router"
import {
	BookOpen,
	Button,
	SearchField,
	Select,
	SelectItem,
	Text,
	focusRing,
	navigationItem,
	useTheme,
} from "maui"
import { useStyles } from "purse-styles"
import { useState } from "react"
import { docSections } from "../documents.js"

export const Route = createFileRoute("/docs")({ component: DocsLayout })

function DocsLayout() {
	const [search, setSearch] = useState("")
	const [menuOpen, setMenuOpen] = useState(false)
	const { preference, setPreference } = useTheme()
	const pathname = useLocation({ select: (location) => location.pathname })
	const navClass = useStyles(navigationItem, focusRing(), {
		display: "block",
		textDecoration: "none",
	})
	const matchingSections = docSections.map((section) => ({
		...section,
		pages: section.pages.filter((page) =>
			page.title.toLowerCase().includes(search.toLowerCase()),
		),
	}))
	return (
		<div className="docs-shell">
			<header className="docs-mobile-header">
				<Link to="/" className="wordmark">
					Tandem
				</Link>
				<Button
					variant="quiet"
					aria-expanded={menuOpen}
					aria-controls="docs-sidebar"
					onPress={() => setMenuOpen(!menuOpen)}
				>
					{menuOpen ? "Close menu" : "Menu"}
				</Button>
			</header>
			<aside
				id="docs-sidebar"
				className={`docs-sidebar${menuOpen ? " is-open" : ""}`}
			>
				<Link to="/" className="wordmark docs-brand">
					<Text size="lg" fontWeight={600}>
						Tandem
					</Text>
				</Link>
				<div className="docs-label">
					<BookOpen size="xs" />
					<Text size="xs" color="lowContrast">
						Documentation
					</Text>
				</div>
				<Select
					label="Theme"
					value={preference}
					onChange={(value) => {
						if (value === "system" || value === "light" || value === "dark")
							setPreference(value)
					}}
				>
					<SelectItem id="system">System</SelectItem>
					<SelectItem id="light">Light</SelectItem>
					<SelectItem id="dark">Dark</SelectItem>
				</Select>
				<SearchField
					aria-label="Filter documentation pages"
					placeholder="Find a page…"
					value={search}
					onChange={setSearch}
				/>
				<nav aria-label="Documentation" className="docs-navigation">
					{matchingSections.map(
						(section) =>
							section.pages.length > 0 && (
								<div className="nav-section" key={section.title}>
									<Text size="xs" color="lowContrast">
										{section.title}
									</Text>
									<ul>
										{section.pages.map((page) => (
											<li key={page.slug}>
												<Link
													to="/docs/$"
													params={{ _splat: page.slug }}
													className={navClass}
													aria-current={
														pathname === `/docs/${page.slug}` ||
														(page.slug === "overview" &&
															(pathname === "/docs" || pathname === "/docs/"))
															? "page"
															: undefined
													}
													onClick={() => setMenuOpen(false)}
												>
													{page.title}
												</Link>
											</li>
										))}
									</ul>
								</div>
							),
					)}
					{matchingSections.every((section) => section.pages.length === 0) && (
						<div className="search-empty">
							<Text size="sm" color="lowContrast">
								No pages found. Try another name.
							</Text>
						</div>
					)}
				</nav>
				<a
					className="sidebar-source"
					href="https://github.com/tanishqkancharla/tandem"
				>
					GitHub ↗
				</a>
			</aside>
			<main id="main" className="docs-main">
				<Outlet />
			</main>
		</div>
	)
}
