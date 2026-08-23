import type { AnySchema } from "@tandem/types"
import { MemoryRemoteStore } from "./MemoryRemoteStore"
import { RemoteServer } from "./RemoteServer"

export class InMemoryRemote<
	Schema extends AnySchema = AnySchema,
> extends RemoteServer<Schema> {
	constructor() {
		super({ store: new MemoryRemoteStore<Schema>() })
	}
}
