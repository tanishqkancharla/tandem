import type {
	AnySchema,
	ClientId,
	MutationId,
	SchemaToTupleSchema,
} from "@tanishqkancharla/tandem-core"
import type {
	TandemIndexMetadataTuple,
	TandemIndexTuple,
} from "@tanishqkancharla/tandem-core/internal"
import type { ScanStorageArgs, WriteOps } from "tuple-database"

export type TandemClientTuple = {
	key: ["client", ClientId]
	value: { lastMutationId: MutationId }
}

export type { TandemIndexMetadataTuple, TandemIndexTuple }

/**
 * Every tuple Tandem stores: records, client acknowledgements, and, for
 * schemas that declare indexes, index entries and their definitions.
 */
export type TandemTuple<Schema extends AnySchema> =
	| SchemaToTupleSchema<Schema>
	| TandemClientTuple
	| TandemIndexTuple
	| TandemIndexMetadataTuple

export interface TandemServerStorageApi<Schema extends AnySchema> {
	scan(args?: ScanStorageArgs): Promise<TandemTuple<Schema>[]>

	commit(writes: WriteOps<TandemTuple<Schema>>): Promise<void>

	/**
	 * Optional change notifications, including external writes when supported.
	 * Notify after changes are readable through scan. Duplicate notifications are
	 * allowed. Callbacks request refreshes synchronously; do not await client pulls.
	 * Return a synchronous unsubscribe function.
	 */
	subscribe?(onChange: () => void): () => void

	close(): Promise<void>
}
