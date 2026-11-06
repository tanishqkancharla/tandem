import type {
	AnySchema,
	CandidateRead,
	ClientId,
	MutationId,
	SchemaToTupleSchema,
} from "@tanishqkancharla/tandem-core"
import type { ScanStorageArgs, WriteOps } from "tuple-database"

export type TandemClientTuple = {
	key: ["client", ClientId]
	value: { lastMutationId: MutationId }
}

export type TandemTuple<Schema extends AnySchema> =
	| SchemaToTupleSchema<Schema>
	| TandemClientTuple

export interface TandemServerStorageApi<Schema extends AnySchema> {
	scan(args?: ScanStorageArgs): Promise<TandemTuple<Schema>[]>

	commit(writes: WriteOps<TandemTuple<Schema>>): Promise<void>

	/**
	 * Optional native query reads. Resolve with every record of the read's
	 * collection that could be among the query's results, in key order, or
	 * undefined to have the query scan the collection instead. Extra records
	 * are allowed. Queries inside transactions always scan.
	 */
	readCandidates?(
		read: CandidateRead,
	): Promise<TandemTuple<Schema>[] | undefined>

	/**
	 * Optional change notifications, including external writes when supported.
	 * Notify after changes are readable through scan. Duplicate notifications are
	 * allowed. Callbacks request refreshes synchronously; do not await client pulls.
	 * Return a synchronous unsubscribe function.
	 */
	subscribe?(onChange: () => void): () => void

	close(): Promise<void>
}
