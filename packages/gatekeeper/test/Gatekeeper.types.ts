import {
	Gatekeeper,
	type HeldCall,
	type Operation,
	type ServiceProxy,
} from "@tanishqkancharla/gatekeeper"
import { expectTypeOf } from "vitest"
import { Client, DeliveryFailed, InvalidValue, Server } from "./services"

// Compile-only consumer checks. This function is never executed by Vitest.
export async function publicApiTypes() {
	const builder = new Gatekeeper()
		.add("server", () => new Server())
		.add("client1", ({ server }) => {
			// Dependencies inside real services retain their ordinary APIs.
			expectTypeOf(server.fetch()).toEqualTypeOf<Promise<number>>()
			return new Client(server)
		})
		.add("client2", ({ server, client1 }) => {
			expectTypeOf(client1).toEqualTypeOf<Client>()
			return new Client(server)
		})

	const { client1, client2, server } = builder.build()
	type WriteResult = number | InvalidValue | DeliveryFailed

	expectTypeOf(client1).toEqualTypeOf<ServiceProxy<Client>>()
	expectTypeOf(client1.write(1)).toEqualTypeOf<Operation<WriteResult>>()
	expectTypeOf(await client1.write(1)).toEqualTypeOf<WriteResult>()
	expectTypeOf(client1.read()).toEqualTypeOf<number>()
	expectTypeOf(client1.isSaving()).toEqualTypeOf<boolean>()

	const call = await client1.write(1).hold()
	expectTypeOf(call).toEqualTypeOf<HeldCall<WriteResult>>()
	expectTypeOf(await call.continue()).toEqualTypeOf<WriteResult>()
	expectTypeOf(
		await call.fail(new Error("injected")),
	).toEqualTypeOf<WriteResult>()
	expectTypeOf(
		await call.continueUntil({ beforeProcessedBy: server }),
	).toEqualTypeOf<void>()
	await call.continueUntil({ afterProcessedBy: server })
	await call.continueUntil({ afterProcessedBy: client2 })

	// @ts-expect-error Public method arguments retain the service's original type.
	await client1.write("wrong")
	// @ts-expect-error Synchronous observations do not become controlled commands.
	await client1.read().hold()
	// @ts-expect-error A boundary requires one specific phase.
	await call.continueUntil({})
	// @ts-expect-error Before and after cannot be requested together.
	await call.continueUntil({
		beforeProcessedBy: server,
		afterProcessedBy: server,
	})
	// @ts-expect-error Raw service instances are not registered proxy identities.
	await call.continueUntil({ beforeProcessedBy: new Server() })
	// @ts-expect-error Fault injection takes an Error.
	await call.fail("offline")
	// @ts-expect-error Existing service names cannot be overwritten.
	builder.add("server", () => new Server())
	// @ts-expect-error Factories can only depend on previously registered services.
	new Gatekeeper().add("client", ({ server }) => new Client(server))
}
