import type { AnySchema } from "@tanishqkancharla/tandem-core"
import { InMemoryTupleStorage } from "tuple-database"
import type { ScanStorageArgs, WriteOps } from "tuple-database"
import type {
	TandemTuple,
	TandemServerStorageApi,
} from "../src/storage/TandemServerStorage.js"

export class TestTandemServerStorage<
	Schema extends AnySchema,
> implements TandemServerStorageApi<Schema> {
	readonly memory = new InMemoryTupleStorage()
	closed = false
	private nextCommitError: Error | undefined
	private nextScanError: Error | undefined
	private nextScanNamespace: TandemTuple<Schema>["key"][0] | undefined
	private nextCommitGate:
		| { entered: () => void; wait: Promise<void> }
		| undefined

	pauseNextCommit() {
		const entered = Promise.withResolvers<void>()
		const release = Promise.withResolvers<void>()
		this.nextCommitGate = { entered: entered.resolve, wait: release.promise }
		return { entered: entered.promise, release: release.resolve }
	}

	failNextCommit(error: Error) {
		this.nextCommitError = error
	}

	failNextScan(error: Error, namespace?: TandemTuple<Schema>["key"][0]) {
		this.nextScanError = error
		this.nextScanNamespace = namespace
	}

	scan(args?: ScanStorageArgs): Promise<TandemTuple<Schema>[]> {
		if (
			this.nextScanError &&
			(this.nextScanNamespace === undefined ||
				args?.gte?.[0] === this.nextScanNamespace)
		) {
			const error = this.nextScanError
			this.nextScanError = undefined
			this.nextScanNamespace = undefined
			return Promise.reject(error)
		}

		return Promise.resolve(this.memory.scan(args) as TandemTuple<Schema>[])
	}

	async commit(writes: WriteOps<TandemTuple<Schema>>): Promise<void> {
		const gate = this.nextCommitGate
		this.nextCommitGate = undefined
		if (gate) {
			gate.entered()
			await gate.wait
		}
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
