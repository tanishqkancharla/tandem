import type { KeyValuePair, ScanStorageArgs, WriteOps } from "tuple-database"
import type { StorageApi } from "@tandem/types"

export class Storage {
	constructor(
		readonly adapter: StorageApi,
		private readonly onFailure: (error: unknown) => void,
	) {}

	async commit(writeOps: WriteOps) {
		try {
			await this.adapter.commit(writeOps)
		} catch (error) {
			this.onFailure(error)
			throw error
		}
	}

	async scan(args?: ScanStorageArgs): Promise<KeyValuePair[]> {
		// TODO: what should we do if this fails?
		return await this.adapter.scan(args)
	}

	async clear() {
		await this.adapter.clear()
	}
}
