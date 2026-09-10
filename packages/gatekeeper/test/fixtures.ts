import { Gatekeeper } from "@tanishqkancharla/gatekeeper"
import { test as base } from "vitest"
import { Client, Server } from "./services"

export function createHarness() {
	return new Gatekeeper()
		.add("server", () => new Server())
		.add("client1", ({ server }) => new Client(server))
		.add("client2", ({ server }) => new Client(server))
		.build()
}

type TestHarness = ReturnType<typeof createHarness>

export const test = base.extend<{
	harness: TestHarness
	client1: TestHarness["client1"]
	client2: TestHarness["client2"]
	server: TestHarness["server"]
}>({
	harness: async ({ task: _task }, use) => {
		await using harness = createHarness()
		await use(harness)
	},
	client1: async ({ harness }, use) => {
		await use(harness.client1)
	},
	client2: async ({ harness }, use) => {
		await use(harness.client2)
	},
	server: async ({ harness }, use) => {
		await use(harness.server)
	},
})
