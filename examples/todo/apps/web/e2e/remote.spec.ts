import { expect, test } from "@playwright/test"

test("HTTP remote returns typed gaps and recovers with consecutive mutations", async ({
	page,
}) => {
	await page.goto("/")
	const responses = await page.evaluate(async () => {
		const modulePath = "/src/TodoHttpRemote.ts"
		const { TodoHttpRemote } = await import(modulePath)
		const remote = new TodoHttpRemote()
		const clientId = crypto.randomUUID()
		const gap = await remote.push({ clientId, mutations: [{ id: 2, ops: [] }] })
		const recovered = await remote.push({
			clientId,
			mutations: [
				{ id: 1, ops: [] },
				{ id: 2, ops: [] },
			],
		})
		const pull = await remote.pull({ clientId, scanWindow: [] })
		const invalid = await remote.pull({
			clientId,
			scanWindow: [
				{ collection: "todos", with: { missing: { collection: "todos" } } },
			],
		})
		return { gap, recovered, pull, invalid }
	})
	expect(responses.gap).toEqual({
		error: "mutation-gap",
		expectedMutationId: 1,
		receivedMutationId: 2,
	})
	expect(responses.recovered).toEqual({ ok: true })
	expect(responses.pull).toMatchObject({
		lastMutationId: 2,
		patch: { set: [], remove: [] },
	})
	expect(responses.invalid).toEqual({
		error: "invalid-request",
		message: 'Unknown relation "todos.missing"',
	})
})

test("HTTP remote returns unavailable for a lost request", async ({ page }) => {
	await page.goto("/")
	await page.route("**/api/tandem", (route) => route.abort("connectionreset"))
	const response = await page.evaluate(async () => {
		const modulePath = "/src/TodoHttpRemote.ts"
		const { TodoHttpRemote } = await import(modulePath)
		return new TodoHttpRemote().push({
			clientId: crypto.randomUUID(),
			mutations: [],
		})
	})
	expect(response).toMatchObject({ error: "unavailable" })
})
