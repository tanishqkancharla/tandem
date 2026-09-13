import type { AnySchema } from "@tanishqkancharla/tandem-core"
import type {
	TandemServerStorageApi,
	TandemTuple,
} from "@tanishqkancharla/tandem-server"
import { InMemoryTupleStorage } from "tuple-database"
import type { ScanStorageArgs, WriteOps } from "tuple-database"

export class TestTandemServerStorage<
	Schema extends AnySchema,
> implements TandemServerStorageApi<Schema> {
	private readonly memory = new InMemoryTupleStorage()

	scan(args?: ScanStorageArgs): Promise<TandemTuple<Schema>[]> {
		return Promise.resolve(this.memory.scan(args) as TandemTuple<Schema>[])
	}

	commit(writes: WriteOps<TandemTuple<Schema>>): Promise<void> {
		this.memory.commit(writes)
		return Promise.resolve()
	}

	close(): Promise<void> {
		this.memory.close()
		return Promise.resolve()
	}
}
