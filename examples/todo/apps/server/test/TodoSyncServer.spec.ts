import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import type {
	ClientId,
	MutationId,
	RemoteApi,
	ScanWindow,
} from "@tanishqkancharla/tandem-core"
import { tag } from "@tanishqkancharla/tandem-core"
import type { TodoSchema } from "@tandem/example-todo-shared"
import { expect, test as baseTest } from "vitest"
import { createTodoSyncServer } from "../src/TodoSyncServer"

const test = baseTest.extend<{ filePath: string }>({
	// oxlint-disable-next-line no-empty-pattern -- Vitest fixtures require destructuring.
	filePath: async ({}, use) => {
		const directory = await fs.mkdtemp(
			path.join(os.tmpdir(), "tandem-todo-server-"),
		)
		await use(path.join(directory, "tandem.json"))
		await fs.rm(directory, { recursive: true, force: true })
	},
})

const scanWindow: ScanWindow<TodoSchema> = [{ collection: "todos" }]

test("syncs client mutations through TandemServer and survives restart", async ({
	filePath,
}) => {
	const firstServer = await createTodoSyncServer({ filePath })
	if (firstServer instanceof Error) throw firstServer

	const firstClient = tag<ClientId>("client-1")
	const initial = await firstServer.pull({
		clientId: firstClient,
		scanWindow,
	})
	expect(new Set(initial.patch.set?.map(({ value }) => value.id))).toEqual(
		new Set(["maui", "welcome"]),
	)

	const mutationId = tag<MutationId>("mutation-1")
	const pushArgs: Parameters<RemoteApi<TodoSchema>["push"]>[0] = {
		clientId: firstClient,
		mutations: [
			{
				id: mutationId,
				ops: [
					{
						type: "set",
						collection: "todos",
						value: {
							id: "server-backed",
							text: "Persist on TandemServer",
							complete: false,
							createdAt: 1,
						},
					},
				],
			},
		],
	}
	await firstServer.push(pushArgs)

	const acknowledged = await firstServer.pull({
		clientId: firstClient,
		cookie: initial.cookie,
		scanWindow,
	})
	expect(acknowledged.lastMutationId).toBe(mutationId)
	await firstServer.close()

	const restartedServer = await createTodoSyncServer({ filePath })
	if (restartedServer instanceof Error) throw restartedServer
	const restarted = await restartedServer.pull({
		clientId: tag<ClientId>("client-2"),
		scanWindow,
	})
	expect(restarted.patch.set).toContainEqual({
		collection: "todos",
		value: {
			id: "server-backed",
			text: "Persist on TandemServer",
			complete: false,
			createdAt: 1,
		},
	})
	await restartedServer.close()
})

test("uses TandemServer queries for the subscribed scan window", async ({
	filePath,
}) => {
	const server = await createTodoSyncServer({ filePath })
	if (server instanceof Error) throw server
	const clientId = tag<ClientId>("filtered-client")
	const incompleteTodos: ScanWindow<TodoSchema> = [
		{
			collection: "todos",
			where: [["complete", "=", false]],
		},
	]
	const initial = await server.pull({ clientId, scanWindow: incompleteTodos })
	expect(initial.patch.set?.map(({ value }) => value.id)).toEqual(["welcome"])

	await server.push({
		clientId,
		mutations: [
			{
				id: tag<MutationId>("complete-welcome"),
				ops: [
					{
						type: "set",
						collection: "todos",
						value: {
							id: "welcome",
							text: "Build something with Tandem",
							complete: true,
							createdAt: 1,
						},
					},
				],
			},
		],
	})
	const updated = await server.pull({
		clientId,
		cookie: initial.cookie,
		scanWindow: incompleteTodos,
	})
	expect(updated.patch.set).toEqual([])
	expect(updated.patch.remove).toContainEqual({
		collection: "todos",
		id: "welcome",
	})
	await server.close()
})
