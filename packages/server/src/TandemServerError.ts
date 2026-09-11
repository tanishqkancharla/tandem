import * as errore from "errore"

export type TandemServerOperation =
	| "cancel"
	| "close"
	| "commit"
	| "get"
	| "list"
	| "query"
	| "remove"
	| "set"
	| "subscribe"
	| "update"

export class TandemServerError extends errore.createTaggedError({
	name: "TandemServerError",
	message: "Tandem server $operation failed",
}) {}
