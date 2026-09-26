import {
	Gatekeeper,
	type CallHandle,
	type PendingCall,
	type ServiceProxy,
} from "@tanishqkancharla/gatekeeper"
import { expectTypeOf } from "vitest"

class Server {
	private value = 0

	read(): number {
		return this.value
	}

	save(value: number): Promise<number> {
		this.value = value
		return Promise.resolve(value)
	}
}

class Client {
	constructor(private readonly server: Pick<Server, "save">) {}

	read(): number {
		return 0
	}

	save(value: number): Promise<number> {
		return this.server.save(value)
	}
}

// Compile-only consumer checks. This function is never executed by Vitest.
export async function publicApiTypes() {
	const builder = new Gatekeeper()
		.add("server", () => new Server(), { gates: { enter: false, exit: true } })
		.add("client", ({ server }) => {
			expectTypeOf(server).toEqualTypeOf<Server>()
			return new Client(server)
		})

	const harness = builder.build()

	expectTypeOf(harness.client).toEqualTypeOf<ServiceProxy<Client>>()
	expectTypeOf(harness.client.read()).toEqualTypeOf<number>()
	expectTypeOf(harness.client.save(1)).toEqualTypeOf<
		Promise<CallHandle<number>>
	>()
	expectTypeOf(harness.pendingCalls()).toEqualTypeOf<readonly PendingCall[]>()
	expectTypeOf(await harness.activateGates()).toEqualTypeOf<void>()
	expectTypeOf(await harness.deactivateGates()).toEqualTypeOf<void>()
	expectTypeOf(await harness.deactivateGatesAndSettle()).toEqualTypeOf<void>()

	const result = await harness.client.save(1)
	expectTypeOf(result.result).toEqualTypeOf<Promise<number>>()
	expectTypeOf(await result.continueTo("server")).toEqualTypeOf<void>()
	expectTypeOf(await result.continueToCompletion()).toEqualTypeOf<void>()
	expectTypeOf(await result.fail(new Error("offline"))).toEqualTypeOf<void>()

	// @ts-expect-error Public method arguments retain the service's original type.
	await harness.client.save("wrong")
	// @ts-expect-error Synchronous observations do not become call handles.
	harness.client.read().assertCompleted()
	new Gatekeeper().add("server", () => new Server(), {
		gates: {
			// @ts-expect-error Gate settings are booleans.
			enter: "sometimes",
		},
	})
	// @ts-expect-error Existing service names cannot be overwritten.
	builder.add("server", () => new Server())
	// @ts-expect-error Factories can only depend on previously registered services.
	new Gatekeeper().add("client", ({ server }) => new Client(server))
}
