import type { Tuple } from "tuple-database"
import { decodeTuple, encodeTuple } from "tuple-database/helpers/codec.js"

// tuple-database's codec turns a tuple into a string whose UTF-16 code unit
// order matches tuple order. Postgres compares bytea byte by byte, so write
// each code unit as UTF-8 would write a code point: one to three bytes, with
// lead bytes that sort by range. UTF-8 of the whole string would not work: it
// reorders surrogate pairs after U+E000-U+FFFF and cannot hold lone surrogates.
export function encodeTandemPostgresKey(tuple: Tuple): Uint8Array {
	const encoded = encodeTuple(tuple)
	const bytes = new Uint8Array(encoded.length * 3)
	let length = 0
	for (let index = 0; index < encoded.length; index++) {
		const unit = encoded.charCodeAt(index)
		if (unit < 0x80) {
			bytes[length++] = unit
			continue
		}
		if (unit < 0x800) {
			bytes[length++] = 0xc0 | (unit >> 6)
			bytes[length++] = 0x80 | (unit & 0x3f)
			continue
		}
		bytes[length++] = 0xe0 | (unit >> 12)
		bytes[length++] = 0x80 | ((unit >> 6) & 0x3f)
		bytes[length++] = 0x80 | (unit & 0x3f)
	}
	return bytes.subarray(0, length)
}

export function decodeTandemPostgresKey(bytes: Uint8Array): Tuple {
	const units: number[] = []
	let index = 0
	while (index < bytes.length) {
		const lead = bytes[index]
		if (lead < 0x80) {
			units.push(lead)
			index += 1
			continue
		}
		if (lead < 0xe0) {
			units.push(((lead & 0x1f) << 6) | (bytes[index + 1] & 0x3f))
			index += 2
			continue
		}
		units.push(
			((lead & 0x0f) << 12) |
				((bytes[index + 1] & 0x3f) << 6) |
				(bytes[index + 2] & 0x3f),
		)
		index += 3
	}
	return decodeTuple(codeUnitsToString(units))
}

function codeUnitsToString(units: number[]) {
	// Spread in chunks to stay under engine argument limits for long keys.
	const chunks: string[] = []
	for (let start = 0; start < units.length; start += 8192) {
		chunks.push(String.fromCharCode(...units.slice(start, start + 8192)))
	}
	return chunks.join("")
}
