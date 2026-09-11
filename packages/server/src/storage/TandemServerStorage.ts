import type {
	AnySchema,
	SchemaToTupleSchema,
} from "@tanishqkancharla/tandem-core"
import type { ScanStorageArgs, WriteOps } from "tuple-database"

export type TandemTuple<Schema extends AnySchema> = SchemaToTupleSchema<Schema>

export interface TandemServerStorageApi<Schema extends AnySchema> {
	scan(args?: ScanStorageArgs): Promise<TandemTuple<Schema>[]>

	commit(writes: WriteOps<TandemTuple<Schema>>): Promise<void>

	close(): Promise<void>
}
