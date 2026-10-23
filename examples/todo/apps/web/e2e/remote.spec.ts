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

test("HTTP mutation decoding rejects invalid fields before applying any operations", async ({
	page,
}) => {
	await page.goto("/")
	const result = await page.evaluate(async () => {
		const modulePath = "/src/TodoHttpRemote.ts"
		const { TodoHttpRemote } = await import(modulePath)
		const remote = new TodoHttpRemote()
		const clientId = crypto.randomUUID()
		const id = crypto.randomUUID()
		const created = { id, text: "Wire record", complete: false, createdAt: 123 }
		const accepted = await remote.push({
			clientId,
			mutations: [
				{
					id: 1,
					ops: [
						{ type: "set", collection: "todos", value: created },
						{
							type: "update",
							collection: "todos",
							id,
							payload: { complete: true },
						},
					],
				},
			],
		})

		// Bypass the typed client encoder to exercise untrusted HTTP input.
		const rejected = []
		for (const invalidOperation of [
			{
				type: "update",
				collection: "todos",
				id,
				payload: { complete: "not a boolean" },
			},
			{ type: "update", collection: "todos", id, payload: { unknown: true } },
			{ type: "update", collection: "todos", id, payload: null },
			{ type: "set", collection: "todos", value: { text: "Missing identity" } },
		]) {
			const response = await fetch("/api/tandem", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					action: "push",
					args: {
						clientId,
						mutations: [
							{
								id: 2,
								ops: [
									{
										type: "update",
										collection: "todos",
										id,
										payload: { text: "Must not apply" },
									},
									invalidOperation,
								],
							},
						],
					},
				}),
			})
			rejected.push({ status: response.status, body: await response.json() })
		}
		const pulled = await remote.pull({
			clientId,
			scanWindow: [{ collection: "todos", where: [["id", "=", id]] }],
		})
		return {
			accepted,
			rejected,
			pulled,
			expected: { ...created, complete: true },
		}
	})
	expect(result.accepted).toEqual({ ok: true })
	expect(result.rejected).toEqual(
		Array.from({ length: 4 }, () => ({
			status: 400,
			body: { error: "invalid-request", message: "Invalid Tandem request" },
		})),
	)
	expect(result.pulled).toMatchObject({
		lastMutationId: 1,
		patch: { set: [{ collection: "todos", value: result.expected }] },
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
