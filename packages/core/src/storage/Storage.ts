import type {
	AsyncTupleStorageApi,
	KeyValuePair,
	ScanStorageArgs,
	WriteOps,
} from "tuple-database"
import { isEqual } from "../utils/objectUtils"

export interface StorageApi extends AsyncTupleStorageApi {
	clear(): Promise<void>
}

export namespace WriteOpsApi {
	export function toString(writeOps: WriteOps): string {
		return `WriteOps {\n${
			writeOps.set
				?.map(
					(op) =>
						`  set (${op.key[1]}) ${JSON.stringify(op.value, undefined, 2)}`,
				)
				.join("\n") ?? ""
		}\n${writeOps.remove?.map((op) => `  remove (${op})`).join("\n") ?? ""}}`
	}

	export function merge(...allWriteOps: WriteOps[]): WriteOps {
		const target: WriteOps = {
			set: [],
			remove: [],
		}

		for (const { set = [], remove = [] } of allWriteOps) {
			for (const { key, value } of set) {
				// Filter out all the keys that we marked as set
				target.remove = target.remove?.filter(
					(removedKey) => !isEqual(removedKey, key),
				)

				target.set ??= []
				target.set.push({ key, value })
			}

			for (const key of remove) {
				target.set = target.set?.filter(
					({ key: keySet }) => !isEqual(keySet, key),
				)

				target.remove ??= []
				target.remove.push(key)
			}
		}

		return target
	}
}

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
