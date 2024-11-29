export type Json =
	| string
	| number
	| boolean
	| null
	| Json[]
	| { [key: string]: Json }

export type AnyFunction = (...args: any[]) => any

export type AnyFunctionMap = Record<string, AnyFunction>

export type Promisify<T> = Promise<Awaited<T>>

export type AsyncApi<Api extends AnyFunctionMap> = {
	[Key in keyof Api]: (
		...args: Parameters<Api[Key]>
	) => Promisify<ReturnType<Api[Key]>>
}

export type Destructor = () => void

export function joinDestructors(destructors: Destructor[]) {
	return () => {
		destructors.forEach((destructor) => destructor())
	}
}

export type Callback<T> = (value: T) => void

export type Span = [from: number, to: number]
export namespace Spans {
	export function includes(reference: Span, test: Span) {
		return reference[0] <= test[0] && reference[1] >= test[1]
	}
}

export function unreachable(snoozeHint: never): never {
	throw new Error("Unreachable code reached: " + JSON.stringify(snoozeHint))
}

export type Assert<Actual extends Expected, Expected> = Actual

const tagSymbol = Symbol("tag")
export type Tagged<Tag extends string, T> = T & { [tagSymbol]: Tag }

export function tag<TagType extends Tagged<any, any>>(
	value: Omit<TagType, typeof tagSymbol>,
): TagType {
	return value as TagType
}

export type Unsubscribe = () => void
