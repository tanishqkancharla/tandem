import type {
	AsyncTupleStorageApi,
	KeyValuePair,
	ScanStorageArgs,
	WriteOps,
} from "tuple-database"

export class Storage {
	constructor(
		private readonly adapter: AsyncTupleStorageApi,
		private readonly onFailure: (error: unknown) => void,
	) {}

	async commit(writeOps: WriteOps) {
		try {
			await this.adapter.commit(writeOps)
		} catch (error) {
			this.onFailure(error)
		}
	}

	async scan(args?: ScanStorageArgs): Promise<KeyValuePair[]> {
		// TODO: what should we do if this fails?
		return await this.adapter.scan(args)
	}
}
