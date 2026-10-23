import * as errore from "errore"
import { isObject, isString } from "./objectUtils.js"
import { Assert, TestExtends } from "./typeUtils.js"

export type Codec<I, O> = {
	name: string
	encode(input: unknown): O
	decode(input: unknown): I
}

export type AnyCodec = Codec<any, any>

export type Encoded<T> = T extends Codec<any, infer O> ? O : never
export type Decoded<T> = T extends Codec<infer I, any> ? I : never

declare const partialObjectRecord: unique symbol

/** Transforms supplied fields only; omissions and cross-field invariants are not validated. */
export type PartialObjectCodec<I, O> = Codec<Partial<I>, Partial<O>> & {
	readonly kind: "partialObject"
	readonly [partialObjectRecord]?: I
}

class PartialObjectInputError extends errore.createTaggedError({
	name: "PartialObjectInputError",
	message: "Invalid partial object: $detail",
}) {}

class CodecImpl<I, O> implements Codec<I, O> {
	constructor(
		readonly name: string,
		readonly internalEncode: (input: unknown) => O,
		readonly internalDecode: (input: unknown) => I,
	) {}

	encode(input: unknown): O {
		return this.internalEncode(input as I)
	}

	decode(input: unknown): I {
		return this.internalDecode(input as O)
	}
}

type _TestCodecSuperset = Assert<
	TestExtends<Codec<string, string>, Codec<string, string | number | boolean>>
>

export function codec<I, O>(
	name: string,
	encode: (input: unknown) => O,
	decode: (input: unknown) => I,
): Codec<I, O> {
	return new CodecImpl(name, encode, decode)
}

export const string = new CodecImpl<string, string>(
	"string",
	(input) => {
		if (!isString(input)) {
			throw new Error(`Expected string but instead found ${typeof input}`)
		}
		return input
	},
	(input) => {
		if (!isString(input)) {
			throw new Error(`Expected string but instead found ${typeof input}`)
		}
		return input
	},
)

export function literal<T extends string | number | boolean>(
	value: T,
): Codec<T, T> {
	return new CodecImpl<T, T>(
		`literal(${value})`,
		(encoded) => {
			if (encoded !== value) {
				throw new Error(`Expected ${value} but instead found ${encoded}`)
			}
			return encoded as T
		},
		(input) => {
			if (input !== value) {
				throw new Error(`Expected ${value} but instead found ${input}`)
			}
			return input as T
		},
	)
}

export const date = new CodecImpl<Date, string>(
	"date",
	(input) => {
		if (!(input instanceof Date)) {
			throw new Error(`Expected date but instead found ${typeof input}`)
		}
		return input.toISOString()
	},
	(input) => {
		if (!isString(input)) {
			throw new Error(`Expected string but instead found ${typeof input}`)
		}
		return new Date(input)
	},
)

export function partialObject<T extends Record<string, AnyCodec>>(
	shape: T,
): PartialObjectCodec<
	{ [K in keyof T]: Decoded<T[K]> },
	{ [K in keyof T]: Encoded<T[K]> }
> {
	function transform(input: unknown, direction: "encode" | "decode") {
		if (!isObject(input) || Array.isArray(input)) {
			return new PartialObjectInputError({ detail: "expected an object" })
		}

		const entries: [string, unknown][] = []
		for (const [key, value] of Object.entries(input)) {
			if (!Object.hasOwn(shape, key)) {
				return new PartialObjectInputError({ detail: `unknown field "${key}"` })
			}
			entries.push([key, shape[key][direction](value)])
		}
		return Object.fromEntries(entries)
	}

	return Object.assign(
		new CodecImpl(
			`partialObject({\n  ${Object.entries(shape)
				.map(([key, codec]) => `${key}: ${codec.name}`)
				.join(",\n  ")}\n})`,
			(input) => {
				const output = transform(input, "encode")
				if (output instanceof Error) throw output
				return output as {
					[K in keyof T]?: Encoded<T[K]>
				}
			},
			(input) => {
				const output = transform(input, "decode")
				if (output instanceof Error) throw output
				return output as {
					[K in keyof T]?: Decoded<T[K]>
				}
			},
		),
		{ kind: "partialObject" as const },
	)
}

export function oneOf<T extends AnyCodec[]>(
	...codecs: T
): Codec<Decoded<T[number]>, Encoded<T[number]>> {
	return new CodecImpl<Decoded<T[number]>, Encoded<T[number]>>(
		`oneOf(\n  ${codecs.map((c) => c.name).join(",\n  ")}\n)`,
		(input) => {
			const errors: string[] = []
			for (const codec of codecs) {
				try {
					const encoded = codec.encode(input)
					if (encoded !== undefined) {
						return encoded
					}
				} catch (error) {
					errors.push(`${codec.name}: ${error}`)
				}
			}

			throw new Error(`No codec matched ${input}: \n${errors.join("\n")}`)
		},
		(input) => {
			const errors: string[] = []
			for (const codec of codecs) {
				try {
					return codec.decode(input)
				} catch (error) {
					errors.push(`${codec.name}: ${error}`)
				}
			}
			throw new Error(`No codec matched ${input}: \n${errors.join("\n")}`)
		},
	)
}
