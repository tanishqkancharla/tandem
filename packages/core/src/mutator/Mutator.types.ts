import {
	type Assert,
	collection,
	defineMutators,
	defineSchema,
	type MutateApi,
	type StandardSchemaV1,
	type TestIsEqual,
} from "@tanishqkancharla/tandem-core"

type Message = { id: string; threadId: string; text: string }
const schema = defineSchema({
	messages: collection<Message>({ fields: ["id", "threadId", "text"] }),
})

declare const sendArgs: StandardSchemaV1<{
	id: string
	threadId: string
	text: string
}>

const mutators = defineMutators(schema, {
	send: {
		args: sendArgs,
		async run(tx, args) {
			type _Args = Assert<
				TestIsEqual<typeof args, { id: string; threadId: string; text: string }>
			>
			if (await tx.get("messages", args.id)) throw new Error("Message exists")
			tx.set("messages", args)
		},
	},
	rename: {
		// Annotate a parse function's input, or TypeScript cannot infer the arguments.
		args: (input: unknown) => input as { id: string; text: string },
		run: (tx, { id, text }) => tx.update("messages", id, { text }),
	},
})

declare const mutate: MutateApi<typeof mutators>
void mutate.send({ id: "1", threadId: "t", text: "hi" })
void mutate.rename({ id: "1", text: "hi" })
// @ts-expect-error Arguments are typed by the validator.
void mutate.rename({ id: 1 })
// @ts-expect-error Only defined mutators exist.
void mutate.remove({ id: "1" })

defineMutators(schema, {
	write: {
		args: (input: unknown) => input as { id: string },
		// @ts-expect-error Mutators write the schema's collections.
		run: (tx, { id }) => tx.set("users", { id }),
	},
})
