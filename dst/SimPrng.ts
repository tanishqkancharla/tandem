import type { RngApi } from "@tanishqkancharla/tandem-core"

/**
 * Deterministic PRNG implementation (SplitMix32)
 */
export class SimPrng {
	private state: number

	constructor(seed: number) {
		this.state = seed >>> 0
	}

	/**
	 * Returns next 32-bit unsigned integer
	 */
	nextUint32(): number {
		this.state = (this.state + 0x9e3779b9) >>> 0
		let z = this.state
		z = Math.imul(z ^ (z >>> 16), 0x85ebca6b) >>> 0
		z = Math.imul(z ^ (z >>> 13), 0xc2b2ae35) >>> 0
		return (z ^ (z >>> 16)) >>> 0
	}

	/**
	 * Returns float in [0, 1)
	 */
	next(): number {
		return this.nextUint32() / 0x100000000
	}

	/**
	 * Returns integer between min and max inclusive
	 */
	int(min: number, max: number): number {
		return min + Math.floor(this.next() * (max - min + 1))
	}

	/**
	 * Returns true with probability `prob`
	 */
	boolean(prob = 0.5): boolean {
		return this.next() < prob
	}

	/**
	 * Pick a random item from an array
	 */
	pick<T>(items: readonly T[]): T {
		if (items.length === 0) {
			throw new Error("Cannot pick from empty array")
		}
		return items[this.int(0, items.length - 1)]
	}

	/**
	 * Id source for one participant incarnation, derived from the seed and its
	 * name alone. Ids never depend on the run's choices, so a replay that makes
	 * no choices still generates the same ids.
	 */
	static idSource(seed: number, name: string): RngApi {
		const stream = new SimPrng(hash(`${seed}:${name}`))
		return {
			randomId: () => `${name}-${stream.nextUint32().toString(36)}`,
		}
	}
}

/** FNV-1a over UTF-16 code units. */
function hash(text: string): number {
	let value = 0x811c9dc5
	for (let index = 0; index < text.length; index++) {
		value ^= text.charCodeAt(index)
		value = Math.imul(value, 0x01000193) >>> 0
	}
	return value
}
