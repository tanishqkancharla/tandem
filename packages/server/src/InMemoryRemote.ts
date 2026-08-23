import type { AnySchema } from "@tandem/types"
import { InMemoryRemoteStore } from "./InMemoryRemoteStore"
import { RemoteServer } from "./RemoteServer"

export class InMemoryRemote<
	Schema extends AnySchema = AnySchema,
> extends RemoteServer<Schema> {
	constructor() {
		super({ store: new InMemoryRemoteStore<Schema>() })
	}
}
