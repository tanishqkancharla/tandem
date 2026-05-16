import type {
	AnySchema,
	CollectionName,
	EncodedQuery,
	EncodedWhereClause,
	Mutation,
	Patch,
	PatchSetOp,
} from "@tandem/types"
import { RemoteServer, type RemoteStore } from "./RemoteServer"

function compareValues(
	fieldValue: unknown,
	operator: string,
	comparisonValue: unknown,
): boolean {
	switch (operator) {
		case "=":
			return Object.is(fieldValue, comparisonValue)
		case ">":
			return (fieldValue as any) > (comparisonValue as any)
		case "<":
			return (fieldValue as any) < (comparisonValue as any)
		case ">=":
			return (fieldValue as any) >= (comparisonValue as any)
		case "<=":
			return (fieldValue as any) <= (comparisonValue as any)
		default:
			throw new Error(`Unknown where operator "${operator}"`)
	}
}

function matchesWhere<
	Schema extends AnySchema,
	Collection extends CollectionName<Schema>,
>(
	record: Schema[Collection],
	where: EncodedWhereClause<Schema, Collection>[] | undefined,
): boolean {
	return (where ?? []).every(([field, operator, value]) =>
		compareValues(record[field], operator, value),
	)
}

function compareByOrder<Schema extends AnySchema>(
	order: NonNullable<EncodedQuery<Schema>["order"]>,
) {
	return (left: Schema[CollectionName<Schema>], right: Schema[CollectionName<Schema>]) => {
		for (const [field, direction] of order) {
			const leftValue = left[field]
			const rightValue = right[field]
			if (Object.is(leftValue, rightValue)) continue

			const result = leftValue > rightValue ? 1 : -1
			return direction === "asc" ? result : -result
		}

		return 0
	}
}

class InMemoryRemoteStore<Schema extends AnySchema> implements RemoteStore<Schema> {
	private readonly recordsByCollection = new Map<
		CollectionName<Schema>,
		Map<string | number, Schema[CollectionName<Schema>]>
	>()

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

	readSnapshot(snapshotQueries: EncodedQuery<Schema>[]): Promise<Patch<Schema>> {
		const set: PatchSetOp<Schema>[] = []
		for (const query of snapshotQueries) {
			const rows = this.readRows(query)
			for (const row of rows) {
				set.push({ collection: query.collection, value: row } as PatchSetOp<Schema>)
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

export class InMemoryRemote<Schema extends AnySchema = AnySchema> extends RemoteServer<Schema> {
	constructor() {
		super({ store: new InMemoryRemoteStore<Schema>() })
	}
}
