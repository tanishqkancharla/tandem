/**
 * A digest of a record's contents. Equal fingerprints mean the record encodes
 * to the same canonical bytes, so a pull can leave it out of the patch.
 */
export type RecordFingerprint = string & {
	readonly __brand: "RecordFingerprint"
}

const hex = Array.from({ length: 256 }, (_, byte) =>
	byte.toString(16).padStart(2, "0"),
)

/**
 * SHA-256 of the record's canonical encoding, or undefined when the record
 * holds a value without a canonical form, such as a class instance or a
 * cycle. Callers treat undefined as changed, so such records always resend.
 * Synchronous, so pulls stay ordered with the work around them.
 */
export function recordFingerprint(
	value: unknown,
): RecordFingerprint | undefined {
	const parts: string[] = []
	if (!encode(value, parts, new Set())) return undefined
	let output = ""
	for (const byte of sha256(new TextEncoder().encode(parts.join(""))))
		output += hex[byte]
	return output as RecordFingerprint
}

// SHA-256 round constants (FIPS 180-4, section 4.2.2).
const roundConstants = new Uint32Array([
	0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1,
	0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
	0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786,
	0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
	0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147,
	0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
	0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b,
	0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
	0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a,
	0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
	0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
])

/** SHA-256 (FIPS 180-4) of `input`. */
export function sha256(input: Uint8Array): Uint8Array {
	// Pad with 0x80, zeros, and the 64-bit big-endian bit length.
	const blocks = Math.ceil((input.length + 9) / 64)
	const padded = new Uint8Array(blocks * 64)
	padded.set(input)
	padded[input.length] = 0x80
	const view = new DataView(padded.buffer)
	view.setUint32(padded.length - 8, Math.floor(input.length / 0x20000000))
	view.setUint32(padded.length - 4, (input.length * 8) >>> 0)

	const hash = new Uint32Array([
		0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c,
		0x1f83d9ab, 0x5be0cd19,
	])
	const words = new Uint32Array(64)
	const rotate = (word: number, bits: number) =>
		(word >>> bits) | (word << (32 - bits))
	for (let offset = 0; offset < padded.length; offset += 64) {
		for (let index = 0; index < 16; index++)
			words[index] = view.getUint32(offset + index * 4)
		for (let index = 16; index < 64; index++) {
			const early = words[index - 15]!
			const late = words[index - 2]!
			const s0 = rotate(early, 7) ^ rotate(early, 18) ^ (early >>> 3)
			const s1 = rotate(late, 17) ^ rotate(late, 19) ^ (late >>> 10)
			words[index] = (words[index - 16]! + s0 + words[index - 7]! + s1) | 0
		}
		let a = hash[0]!
		let b = hash[1]!
		let c = hash[2]!
		let d = hash[3]!
		let e = hash[4]!
		let f = hash[5]!
		let g = hash[6]!
		let h = hash[7]!
		for (let index = 0; index < 64; index++) {
			const s1 = rotate(e, 6) ^ rotate(e, 11) ^ rotate(e, 25)
			const choose = (e & f) ^ (~e & g)
			const t1 = (h + s1 + choose + roundConstants[index]! + words[index]!) | 0
			const s0 = rotate(a, 2) ^ rotate(a, 13) ^ rotate(a, 22)
			const majority = (a & b) ^ (a & c) ^ (b & c)
			const t2 = (s0 + majority) | 0
			h = g
			g = f
			f = e
			e = (d + t1) | 0
			d = c
			c = b
			b = a
			a = (t1 + t2) | 0
		}
		// Uint32Array stores each sum modulo 2^32.
		hash[0] = hash[0]! + a
		hash[1] = hash[1]! + b
		hash[2] = hash[2]! + c
		hash[3] = hash[3]! + d
		hash[4] = hash[4]! + e
		hash[5] = hash[5]! + f
		hash[6] = hash[6]! + g
		hash[7] = hash[7]! + h
	}
	const output = new Uint8Array(32)
	const outputView = new DataView(output.buffer)
	for (let index = 0; index < 8; index++)
		outputView.setUint32(index * 4, hash[index]!)
	return output
}

/**
 * Appends a tagged, length-prefixed encoding of `value`, so different values
 * of the supported types never share an encoding. Object keys are sorted, so
 * key insertion order does not matter.
 */
function encode(value: unknown, parts: string[], ancestors: Set<object>) {
	switch (typeof value) {
		case "undefined":
			parts.push("u")
			return true
		case "boolean":
			parts.push(value ? "t" : "f")
			return true
		case "number":
			// String() round-trips every number except the sign of zero.
			parts.push("d", Object.is(value, -0) ? "-0" : String(value), ";")
			return true
		case "bigint":
			parts.push("b", value.toString(), ";")
			return true
		case "string": {
			// UTF-8 replaces lone surrogates, so escape strings that have them.
			const text = value.isWellFormed() ? value : JSON.stringify(value)
			parts.push(text === value ? "s" : "w", String(text.length), ":", text)
			return true
		}
		case "object":
			break
		default:
			return false
	}
	if (value === null) {
		parts.push("n")
		return true
	}
	if (ancestors.has(value)) return false
	ancestors.add(value)
	const encoded = encodeObject(value, parts, ancestors)
	ancestors.delete(value)
	return encoded
}

function encodeObject(value: object, parts: string[], ancestors: Set<object>) {
	if (Array.isArray(value)) {
		parts.push("a", String(value.length), ":")
		for (let index = 0; index < value.length; index++)
			if (!encode(value[index], parts, ancestors)) return false
		return true
	}
	if (value instanceof Date) {
		parts.push("D", String(value.getTime()), ";")
		return true
	}
	if (value instanceof Uint8Array && value.constructor === Uint8Array) {
		parts.push("B", String(value.length), ":")
		for (const byte of value) parts.push(hex[byte]!)
		return true
	}
	if (value instanceof Map && value.constructor === Map)
		return encodeEntries("M", [...value], parts, ancestors)
	if (value instanceof Set && value.constructor === Set)
		return encodeEntries(
			"S",
			[...value].map((item) => [item, true] as const),
			parts,
			ancestors,
		)
	const prototype = Object.getPrototypeOf(value)
	if (prototype !== Object.prototype && prototype !== null) return false
	if (Object.getOwnPropertySymbols(value).length) return false
	return encodeEntries(
		"o",
		Object.entries(value).map(([key, item]) => [key, item] as const),
		parts,
		ancestors,
	)
}

/** Encodes entries sorted by their encoded keys, so order does not matter. */
function encodeEntries(
	tag: string,
	entries: readonly (readonly [unknown, unknown])[],
	parts: string[],
	ancestors: Set<object>,
) {
	const encoded: [key: string, value: string][] = []
	for (const [key, item] of entries) {
		const keyParts: string[] = []
		const valueParts: string[] = []
		if (
			!encode(key, keyParts, ancestors) ||
			!encode(item, valueParts, ancestors)
		)
			return false
		encoded.push([keyParts.join(""), valueParts.join("")])
	}
	encoded.sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
	parts.push(tag, String(encoded.length), ":")
	for (const [key, item] of encoded) parts.push(key, item)
	return true
}
