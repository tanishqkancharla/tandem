export function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null
}

export function pick<T extends Record<string, unknown>, Keys extends keyof T>(
	object: T,
	keys: readonly Keys[],
): Pick<T, Keys> {
	const result: Pick<T, Keys> = {} as Pick<T, Keys>

	for (const key of keys) {
		result[key] = object[key]
	}

	return result
}

export function pickBy<T extends Record<string, unknown>>(
	object: T,
	predicate: (value: T[keyof T]) => boolean,
): Partial<T> {
	return Object.fromEntries(
		Object.entries(object).filter(([_key, value]) =>
			predicate(value as T[keyof T]),
		),
	) as Partial<T>
}

export function isEqual<T>(a: T, b: T): boolean {
	if (a == b) {
		return true
	}

	return JSON.stringify(a) === JSON.stringify(b)
}

export function partition<T, T1 extends T>(
	arr: readonly T[],
	predicate: (value: T) => value is T1,
): [T1[], Exclude<T, T1>[]]
export function partition<T>(
	arr: readonly T[],
	predicate: (value: T) => boolean,
): [T[], T[]] {
	const trueArr: T[] = []
	const falseArr: T[] = []

	for (const value of arr) {
		if (predicate(value)) {
			trueArr.push(value)
		} else {
			falseArr.push(value)
		}
	}

	return [trueArr, falseArr]
}

export function reverse<T>(arr: readonly T[]): T[] {
	return [...arr].reverse()
}

export function intersection<T>(a: readonly T[], b: readonly T[]): T[] {
	return a.filter((value) => b.includes(value))
}

export function difference<T>(a: readonly T[], b: readonly T[]): T[] {
	return a.filter((value) => !b.includes(value))
}

export function isArray(value: unknown): value is any[] {
	return Array.isArray(value)
}

export function isPlainObject(
	value: unknown,
): value is Record<string, unknown> {
	return isObject(value) && value.constructor === Object
}

export function isFunction(value: unknown): value is (...args: any[]) => any {
	return typeof value === "function"
}

export function sortBy<T, V extends string | number>(
	arr: readonly T[],
	...sortFns: (readonly [(item: T) => V, "asc" | "desc"])[]
): T[] {
	return [...arr].sort((a, b) => {
		for (const [sortFn, order] of sortFns) {
			const aValue = sortFn(a)
			const bValue = sortFn(b)
			if (aValue > bValue) {
				return order === "asc" ? 1 : -1
			} else if (aValue < bValue) {
				return order === "asc" ? -1 : 1
			}
		}

		return 0
	})
}

export function isString(value: unknown): value is string {
	return typeof value === "string"
}

export function mapValues<T extends Record<string, unknown>, V>(
	object: T,
	fn: (value: T[keyof T], key: keyof T) => V,
): { [K in keyof T]: V } {
	const result: { [K in keyof T]: V } = {} as { [K in keyof T]: V }

	for (const key in object) {
		result[key] = fn(object[key], key)
	}

	return result
}
