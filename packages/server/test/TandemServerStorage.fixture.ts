import type { AnySchema } from "@tanishqkancharla/tandem-core"
import { InMemoryTupleStorage } from "tuple-database"
import type { ScanStorageArgs, WriteOps } from "tuple-database"
import type {
	TandemTuple,
	TandemServerStorageApi,
} from "../src/storage/TandemServerStorage"

export class TestTandemServerStorage<
	Schema extends AnySchema,
> implements TandemServerStorageApi<Schema> {
	readonly memory = new InMemoryTupleStorage()
	closed = false
	private nextCommitError: Error | undefined
	private nextScanError: Error | undefined

	failNextCommit(error: Error) {
		this.nextCommitError = error
	}

	failNextScan(error: Error) {
		this.nextScanError = error
	}

	scan(args?: ScanStorageArgs): Promise<TandemTuple<Schema>[]> {
		if (this.nextScanError) {
			const error = this.nextScanError
			this.nextScanError = undefined
			return Promise.reject(error)
		}

		return Promise.resolve(this.memory.scan(args) as TandemTuple<Schema>[])
	}

	commit(writes: WriteOps<TandemTuple<Schema>>): Promise<void> {
		if (this.nextCommitError) {
			const error = this.nextCommitError
			this.nextCommitError = undefined
			return Promise.reject(error)
		}

		this.memory.commit(writes)
		return Promise.resolve()
	}

	close(): Promise<void> {
		this.closed = true
		this.memory.close()
		return Promise.resolve()
	}
}
