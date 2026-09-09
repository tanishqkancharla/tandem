import { Gatekeeper, type GateCall } from "../src/index"

type Assert<_Test extends true> = void
type TestIsEqual<A extends B, B> = A extends B
	? B extends A
		? true
		: false
	: false

class Server {
	async addOne(value: number) {
		return value + 1
	}
}

class Client {
	constructor(private server: Server) {}

	async addOneThroughServer(value: number) {
		return this.server.addOne(value)
	}
}

const harness = new Gatekeeper()
	.add("server", () => new Server())
	.add("client", ({ server }) => new Client(server))
	.build()

type ServerCall = ReturnType<typeof harness.server.addOne>
type ClientCall = ReturnType<typeof harness.client.addOneThroughServer>

type _TestServerCall = Assert<
	TestIsEqual<ServerCall, GateCall<number, [value: number]>>
>
type _TestClientCall = Assert<
	TestIsEqual<ClientCall, GateCall<number, [value: number]>>
>
type _TestAllowResult = Assert<
	TestIsEqual<ReturnType<ServerCall["allow"]>, Promise<number>>
>
type _TestMockResult = Assert<
	TestIsEqual<ReturnType<ClientCall["mockReturnValue"]>, Promise<number>>
>
type _TestNextCall = Assert<
	TestIsEqual<ReturnType<typeof harness.nextCall>, Promise<GateCall>>
>

// @ts-expect-error addOne expects a number
harness.server.addOne("1")

// @ts-expect-error unknown service is not on the harness
const _unknown = harness.database
