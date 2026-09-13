import { expect, test as baseTest, type Page } from "@playwright/test"

const test = baseTest.extend<{ page1: Page; page2: Page }>({
	page1: async ({ page }, use) => {
		await page.goto("/")
		await page
			.getByRole("checkbox", { name: "Build something with Tandem" })
			.waitFor()
		await use(page)
	},
	page2: async ({ baseURL, browser }, use) => {
		const context = await browser.newContext({ baseURL })
		const page = await context.newPage()
		await page.goto("/")
		await page
			.getByRole("checkbox", { name: "Build something with Tandem" })
			.waitFor()
		await use(page)
		await context.close()
	},
})

async function deleteTodoAndWaitForSync({
	page1,
	page2,
	todoText,
}: {
	page1: Page
	page2: Page
	todoText: string
}) {
	await page2.getByRole("checkbox", { name: todoText }).waitFor()
	await page1.getByRole("button", { name: `Delete ${todoText}` }).click()
	await page1
		.getByRole("checkbox", { name: todoText })
		.waitFor({ state: "detached" })
	await page2
		.getByRole("checkbox", { name: todoText })
		.waitFor({ state: "detached" })
}

function uniqueTodoText(label: string) {
	return `${label} ${Date.now()}-${crypto.randomUUID()}`
}

test("renders the todos seeded by the Hono server", async ({ page1 }) => {
	await expect(
		page1.getByRole("checkbox", { name: "Build something with Tandem" }),
	).not.toBeChecked()
	await expect(
		page1.getByRole("checkbox", { name: "Style it with Maui color tokens" }),
	).toBeChecked()
	await expect(page1.getByText("1 remaining")).toBeVisible()
})

test("ignores blank todos and normalizes submitted text", async ({
	page1,
	page2,
}) => {
	const todoInput = page1.getByLabel("New todo")
	const initialTodoCount = await page1.getByRole("checkbox").count()

	await todoInput.fill("   ")
	await page1.getByRole("button", { name: "Add" }).click()
	await expect(page1.getByRole("checkbox")).toHaveCount(initialTodoCount)
	await expect(todoInput).toHaveValue("")

	const todoText = uniqueTodoText("Trimmed todo")
	await todoInput.fill(`  ${todoText}  `)
	await todoInput.press("Enter")

	await expect(page1.getByRole("checkbox", { name: todoText })).toBeVisible()
	await expect(todoInput).toHaveValue("")
	await expect(page1.getByRole("checkbox").first()).toHaveAccessibleName(
		todoText,
	)
	await deleteTodoAndWaitForSync({ page1, page2, todoText })
})

test("persists completion and remaining count across reloads", async ({
	page1,
	page2,
}) => {
	const todoText = uniqueTodoText("Completion todo")
	await page1.getByLabel("New todo").fill(todoText)
	await page1.getByRole("button", { name: "Add" }).click()

	const checkbox = page1.getByRole("checkbox", { name: todoText })
	await expect(checkbox).not.toBeChecked()
	await expect(page1.getByText("2 remaining")).toBeVisible()

	await page1.locator("label").filter({ hasText: todoText }).click()
	await expect(checkbox).toBeChecked()
	await expect(page1.getByText("1 remaining")).toBeVisible()

	await expect(page2.getByRole("checkbox", { name: todoText })).toBeChecked()

	await page1.reload()
	await expect(page1.getByRole("checkbox", { name: todoText })).toBeChecked()
	await expect(page1.getByText("1 remaining")).toBeVisible()
	await deleteTodoAndWaitForSync({ page1, page2, todoText })
})

test("persists deletion across reloads", async ({ page1, page2 }) => {
	const todoText = uniqueTodoText("Deleted todo")
	await page1.getByLabel("New todo").fill(todoText)
	await page1.getByRole("button", { name: "Add" }).click()
	await expect(page1.getByRole("checkbox", { name: todoText })).toBeVisible()

	await deleteTodoAndWaitForSync({ page1, page2, todoText })
	await page2.reload()
	await expect(page2.getByRole("checkbox", { name: todoText })).toHaveCount(0)
})

test("syncs changes in both directions between browser clients", async ({
	page1,
	page2,
}) => {
	const todoText = uniqueTodoText("Shared todo")
	await page1.getByLabel("New todo").fill(todoText)
	await page1.getByRole("button", { name: "Add" }).click()

	const checkbox = page1.getByRole("checkbox", { name: todoText })
	await expect(checkbox).toBeVisible()
	await expect(checkbox).not.toBeChecked()
	const observerCheckbox = page2.getByRole("checkbox", {
		name: todoText,
	})
	await expect(observerCheckbox).toBeVisible()
	await expect(observerCheckbox).not.toBeChecked()

	await page2.locator("label").filter({ hasText: todoText }).click()
	await expect(observerCheckbox).toBeChecked()
	await expect(checkbox).toBeChecked()

	await page1.getByRole("button", { name: `Delete ${todoText}` }).click()
	await expect(page2.getByRole("checkbox", { name: todoText })).toHaveCount(0)
})
