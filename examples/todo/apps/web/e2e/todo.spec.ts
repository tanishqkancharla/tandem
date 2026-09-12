import { expect, test } from "@playwright/test"

test("renders the todos seeded by the Hono server", async ({ page }) => {
	await page.goto("/")

	await expect(
		page.getByRole("checkbox", { name: "Build something with Tandem" }),
	).not.toBeChecked()
	await expect(
		page.getByRole("checkbox", { name: "Style it with Maui color tokens" }),
	).toBeChecked()
	await expect(page.getByText("1 remaining")).toBeVisible()
})

test("syncs todo changes between browser clients and across reloads", async ({
	browser,
	page,
}) => {
	const todoText = `Playwright todo ${Date.now()}`
	const observerContext = await browser.newContext({
		baseURL: "http://127.0.0.1:5174",
	})
	const observerPage = await observerContext.newPage()

	await Promise.all([page.goto("/"), observerPage.goto("/")])
	await expect(page.getByRole("heading", { name: "Todos" })).toBeVisible()
	await expect(
		observerPage.getByRole("checkbox", {
			name: "Build something with Tandem",
		}),
	).toBeVisible()

	await page.getByLabel("New todo").fill(todoText)
	await page.getByRole("button", { name: "Add" }).click()

	const checkbox = page.getByRole("checkbox", { name: todoText })
	await expect(checkbox).toBeVisible()
	await expect(checkbox).not.toBeChecked()
	const observerCheckbox = observerPage.getByRole("checkbox", {
		name: todoText,
	})
	await expect(observerCheckbox).toBeVisible()
	await expect(observerCheckbox).not.toBeChecked()

	await page.locator("label").filter({ hasText: todoText }).click()
	await expect(checkbox).toBeChecked()
	await expect(observerCheckbox).toBeChecked()

	await observerPage.reload()
	await expect(
		observerPage.getByRole("checkbox", { name: todoText }),
	).toBeChecked()

	await page.getByRole("button", { name: `Delete ${todoText}` }).click()
	await expect(
		observerPage.getByRole("checkbox", { name: todoText }),
	).toHaveCount(0)
	await observerContext.close()
})
