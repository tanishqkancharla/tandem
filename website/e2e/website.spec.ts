import { expect, test } from "@playwright/test"

test("copy the setup prompt from the home page", async ({
	browserName,
	context,
	page,
}) => {
	test.skip(
		browserName !== "chromium",
		"Clipboard permissions are Chromium-only",
	)
	await context.grantPermissions(["clipboard-read", "clipboard-write"])
	await page.goto("/")
	await expect(
		page.getByRole("heading", { name: "Real-time sync, no new infra" }),
	).toBeVisible()
	const navigation = page.getByRole("navigation", { name: "Main" })
	await expect(
		navigation.getByRole("link", { name: "Docs", exact: true }),
	).toHaveAttribute("href", "https://docs.tandemsync.dev")
	await expect(
		navigation.getByRole("link", { name: "GitHub", exact: true }),
	).toHaveAttribute("href", "https://github.com/tanishqkancharla/tandem")
	await expect(
		page.getByRole("main").getByRole("link", { name: "Read the docs" }),
	).toHaveAttribute("href", "https://docs.tandemsync.dev")
	await page.getByRole("button", { name: "Add Tandem to my app" }).click()
	await expect(page.getByRole("status")).toHaveText(
		"Copied. Paste it into your coding agent.",
	)
	expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
		"Follow https://tandemsync.dev/setup.md to add Tandem sync to this project.",
	)
	const setup = await page.request.get("/setup.md")
	expect(setup.ok()).toBe(true)
	expect(await setup.text()).toContain("# Add Tandem to this project")
})
