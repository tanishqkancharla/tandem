import { createHash } from "node:crypto"
import { expect, test } from "vitest"
import { sha256 } from "../src/recordFingerprint.js"

test("sha256 matches the platform digest at every padding boundary", () => {
	for (const length of [
		0, 1, 3, 55, 56, 57, 63, 64, 65, 119, 120, 128, 100_000,
	]) {
		const bytes = new Uint8Array(length).map(
			(_, index) => (index * 31 + length) & 255,
		)
		expect(Buffer.from(sha256(bytes)).toString("hex")).toBe(
			createHash("sha256").update(bytes).digest("hex"),
		)
	}
	// FIPS 180-4 example: SHA-256("abc").
	expect(
		Buffer.from(sha256(new TextEncoder().encode("abc"))).toString("hex"),
	).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad")
})
