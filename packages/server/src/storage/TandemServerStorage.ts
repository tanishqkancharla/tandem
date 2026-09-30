import type {
	AnySchema,
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

	close(): Promise<void>
}
