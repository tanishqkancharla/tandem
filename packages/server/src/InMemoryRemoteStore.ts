import type {
	AnySchema,
	CollectionName,
	EncodedQuery,
	Mutation,
	Patch,
	PatchSetOp,
} from "@tandem/types"
import type { RemoteStore } from "./RemoteServer"
import { compareByOrder, matchesWhere } from "./shared"

export class InMemoryRemoteStore<
	Schema extends AnySchema,
> implements RemoteStore<Schema> {
	private readonly recordsByCollection = new Map<
		CollectionName<Schema>,
		Map<string | number, Schema[CollectionName<Schema>]>
	>()

	loadRecords(
		records: Partial<
			Record<CollectionName<Schema>, readonly Schema[CollectionName<Schema>][]>
		>,
	) {
		this.recordsByCollection.clear()
		for (const [collection, collectionRecords] of Object.entries(records) as [
			CollectionName<Schema>,
			readonly Schema[CollectionName<Schema>][] | undefined,
		][]) {
			if (!collectionRecords) continue
			const map = new Map<string | number, Schema[CollectionName<Schema>]>()
			for (const record of collectionRecords) {
				map.set(record.id, record)
			}
			this.recordsByCollection.set(collection, map)
		}
	}

	dumpRecords(): Partial<
		Record<CollectionName<Schema>, Schema[CollectionName<Schema>][]>
	> {
		const records: Partial<
			Record<CollectionName<Schema>, Schema[CollectionName<Schema>][]>
		> = {}
		for (const [collection, collectionRecords] of this.recordsByCollection) {
			records[collection] = Array.from(collectionRecords.values())
		}
		return records
	}

	applyMutations(mutations: Mutation<Schema>[]): Promise<void> {
		for (const mutation of mutations) {
			for (const op of mutation.ops) {
				if (op.type === "set") {
					let collectionRecords = this.recordsByCollection.get(op.collection)
					if (!collectionRecords) {
						collectionRecords = new Map()
						this.recordsByCollection.set(op.collection, collectionRecords)
					}

					collectionRecords.set(op.value.id, op.value)
				} else {
					this.recordsByCollection.get(op.collection)?.delete(op.id)
				}
			}
		}

		return Promise.resolve()
	}

	readSnapshot(
		snapshotQueries: EncodedQuery<Schema>[],
	): Promise<Patch<Schema>> {
		const set: PatchSetOp<Schema>[] = []
		for (const query of snapshotQueries) {
			const rows = this.readRows(query)
			for (const row of rows) {
				set.push({
					collection: query.collection,
					value: row,
				} as PatchSetOp<Schema>)
			}
		}

		return Promise.resolve({ set })
	}

	private readRows<Collection extends CollectionName<Schema>>(
		query: EncodedQuery<Schema, Collection>,
	): Schema[Collection][] {
		let rows = Array.from(
			this.recordsByCollection.get(query.collection)?.values() ?? [],
		) as Schema[Collection][]

		rows = rows.filter((record) => matchesWhere(record, query.where))

		if (query.order?.length) {
			rows = rows.toSorted(compareByOrder(query.order) as any)
		}

		if (query.offset !== undefined) {
			rows = rows.slice(query.offset)
		}

		if (query.limit !== undefined) {
			rows = rows.slice(0, query.limit)
		}

		return rows
	}
}
