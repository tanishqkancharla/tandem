import * as errore from "errore"
import type {
	AnySchema,
	CollectionName,
	CollectionScanArgs,
	RuntimeSchemaDefinition,
} from "../schema/Schema.js"
import type { Transaction } from "../transaction/Transaction.js"
import type { Json } from "../utils/typeUtils.js"

/**
 * The part of the Standard Schema interface Tandem calls, so zod, valibot, or
 * arktype schemas validate mutator arguments directly.
 * https://standardschema.dev
 */
export type StandardSchemaV1<Input = unknown, Output = Input> = {
	readonly "~standard": {
		readonly version: 1
		readonly vendor: string
		readonly validate: (
			value: unknown,
		) =>
			| StandardSchemaV1Result<Output>
			| Promise<StandardSchemaV1Result<Output>>
		readonly types?: { readonly input: Input; readonly output: Output }
	}
}

type StandardSchemaV1Result<Output> =
	| { readonly value: Output; readonly issues?: undefined }
	| { readonly issues: readonly { readonly message: string }[] }

/** Validates a mutator's JSON arguments, on the client before running and again on the server. */
export type MutatorArgs<Input = Json, Output = Input> =
	| StandardSchemaV1<Input, Output>
	| ((input: unknown) => Output)

/**
 * The transaction a shared mutator runs against. Reads return promises because
 * the server reads storage; the client resolves them from memory.
 */
export type MutatorTransaction<Schema extends AnySchema> = {
	get<Collection extends CollectionName<Schema>>(
		collection: Collection,
		id: Schema[Collection]["id"],
	): Promise<Readonly<Schema[Collection]> | undefined>
	scan<Collection extends CollectionName<Schema>>(
		collection: Collection,
		args?: CollectionScanArgs<Schema[Collection]["id"]>,
	): Promise<Readonly<Schema[Collection]>[]>
	set<Collection extends CollectionName<Schema>>(
		collection: Collection,
		record: Schema[Collection],
	): unknown
	/** Assigns supplied top-level fields only if the record exists. */
	update<Collection extends CollectionName<Schema>>(
		collection: Collection,
		id: Schema[Collection]["id"],
		payload: Partial<Omit<Schema[Collection], "id">> & { id?: never },
	): Promise<unknown>
	remove<Collection extends CollectionName<Schema>>(
		collection: Collection,
		id: Schema[Collection]["id"],
	): unknown
}

/** Where a shared mutator is running. The server passes a wider context to its own mutators. */
export type MutatorContext = {
	location: "client" | "server"
}

export type MutatorDefinition<Schema extends AnySchema, Args = Json> = {
	/** Arguments must be JSON: they persist in the outbox and cross the network. */
	args: MutatorArgs<Json, Args>
	run: (
		tx: MutatorTransaction<Schema>,
		args: Args,
		ctx: MutatorContext,
	) => unknown
	/** Server effects belong only to server registration. */
	afterCommit?: never
	authorize?: never
}

export type AnyMutators<Schema extends AnySchema = AnySchema> = {
	// Args is contravariant in run, so only any admits every concrete definition.
	// oxlint-disable-next-line typescript/no-explicit-any
	[name: string]: MutatorDefinition<Schema, any>
}

/** The arguments a mutator takes. */
export type MutatorArgsOf<Definition> = Definition extends {
	args: MutatorArgs<Json, infer Args>
}
	? Args
	: never

/** Named mutation methods shared by client and server APIs. */
export type MutateApi<Mutators> = {
	readonly [Name in keyof Mutators]: (
		args: MutatorArgsOf<Mutators[Name]>,
	) => Promise<void>
}

/** Name and raw JSON arguments of a mutator call, as persisted and pushed. */
export type MutatorCall = { name: string; args: Json }

/**
 * Defines mutators shared by the client and server. Each one runs
 * optimistically on the client and again, authoritatively, on the server.
 */
export function defineMutators<
	Schema extends AnySchema,
	Args extends Record<string, unknown>,
>(
	_schema: RuntimeSchemaDefinition<Schema>,
	mutators: { [Name in keyof Args]: MutatorDefinition<Schema, Args[Name]> },
): { [Name in keyof Args]: MutatorDefinition<Schema, Args[Name]> } {
	return mutators
}

/** Define one shared mutator in its own module with schema and args inference. */
export function defineMutator<Schema extends AnySchema, Args>(
	_schema: RuntimeSchemaDefinition<Schema>,
	definition: MutatorDefinition<Schema, Args>,
): MutatorDefinition<Schema, Args> {
	return definition
}

/** A server rejected a mutation. It was acknowledged with no effect, and the next pull rolls it back. */
export class MutationRejectedError extends errore.createTaggedError({
	name: "MutationRejectedError",
	message: "Mutation $mutationId was rejected: $reason",
}) {}

/** @internal */
export class MutatorArgsError extends errore.createTaggedError({
	name: "MutatorArgsError",
	message: "Invalid arguments for mutator $mutator: $detail",
}) {}

/** @internal */
export async function validateMutatorArgs(
	name: string,
	validator: MutatorArgs<Json, unknown>,
	input: unknown,
) {
	if (typeof validator === "function") {
		// The parser is consumer code, and throws to reject input.
		return errore.try({
			try: () => validator(input),
			catch: (cause) =>
				new MutatorArgsError({
					mutator: name,
					detail: cause instanceof Error ? cause.message : String(cause),
					cause,
				}),
		})
	}
	const result = await validator["~standard"].validate(input)
	if (result.issues)
		return new MutatorArgsError({
			mutator: name,
			detail: result.issues.map(({ message }) => message).join("; "),
		})
	return result.value
}

/** @internal Presents the client's synchronous transaction with the shared async reads. */
export function clientMutatorTransaction<Schema extends AnySchema>(
	tx: Transaction<Schema>,
): MutatorTransaction<Schema> {
	return {
		get: (collection, id) => Promise.resolve(tx.get(collection, id)),
		scan: (collection, args) => Promise.resolve(tx.scan(collection, args)),
		set: (collection, record) => tx.set(collection, record),
		update: (collection, id, payload) =>
			Promise.resolve(tx.update(collection, id, payload)),
		remove: (collection, id) => tx.remove(collection, id),
	}
}
