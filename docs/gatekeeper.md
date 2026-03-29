A concept of testing framework called gatekeeper

core idea is having “gates”. Proxies around each service that controls communication back and forth

```tsx
type ServerApi = {
	async addOne(value: number): Promise<number>
}

type ClientApi = {
  async addOneThroughServer(value: number): Promise<number>
}

const harness =
	new Gatekeeper()
	  .add("server", () => new Server())
	  .add("client", ({ server }: { server: Server }) => new Client(server))
	  .build()


const addOneThroughServerCall = await harness.client.addOneThroughServer(1)

// The client's code runs, then it blocks on the addOne call to the server

// lets the request through to the underlying implementation
// and unblocks client
await addOneThroughServerCall.allow()

// Mocks the return and unblocks client
await addOneThroughServerCall.mockReturnValue(2)

// Mock an error
await addOneThroughServerCall.fail(new Error(...))
```

- To use a service with Gatekeeper, it needs to implement an Async API interface: basically an object of async function methods
- Follow-up services get access to previously built services. Except its really a proxy on top of the service that implements the methods.
- Gates control
  - control communication between services
  - you send from a service
  - the gate stops it from hitting the service being requested immediately
  - you can allow the implementation through or mock the value
