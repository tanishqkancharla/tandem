export type Json =
	| string
	| number
	| boolean
	| null
	| Json[]
	| { [key: string]: Json }

export type AnyFunction = (...args: any[]) => any
export type AnyAsyncFunction = (...args: any[]) => Promise<any>

export type AnyFunctionMap = Record<string, AnyFunction>
export type AnyAsyncFunctionMap = Record<string, AnyAsyncFunction>

export type Caller<T extends AnyFunctionMap> = {
	[K in keyof T]: (...args: Parameters<T[K]>) => Promisify<ReturnType<T[K]>>
}

export type Answerer<T extends AnyFunctionMap> = {
	[K in keyof T]: (
		fn: (
			...args: Parameters<T[K]>
		) => Awaited<ReturnType<T[K]>> | Promise<Awaited<ReturnType<T[K]>>>,
	) => () => void
}

export type Promisify<T> = T extends Promise<any> ? T : Promise<T>

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

export function unreachable(value: never): never {
	throw new Error("Unreachable code reached: " + JSON.stringify(value))
}

export type Assert<_Test extends true> = void
export type TestIsEqual<A extends B, B> = A extends B
	? B extends A
		? true
		: false
	: false
export type TestExtends<A extends B, B> = A extends B ? true : false

const tagSymbol = Symbol("tag")
export type Tagged<Tag extends string, T> = T & { [tagSymbol]: Tag }
export type Untagged<TagType> =
	TagType extends Tagged<any, infer T>
		? T extends string
			? string
			: T extends number
				? number
				: Omit<TagType, typeof tagSymbol>
		: never

export function tag<TagType extends Tagged<any, any>>(
	value: Untagged<TagType>,
): TagType {
	return value as TagType
}

export function untag<TagType extends Tagged<any, any>>(
	value: TagType,
): Untagged<TagType> {
	return value as Untagged<TagType>
}

type _TestExtendsOriginalType = Assert<
	TestExtends<Tagged<"Cookie", number>, number>
>
type _TestTagThenUntag = Assert<
	TestIsEqual<Untagged<Tagged<"Cookie", number>>, number>
>

export type Unsubscribe = () => void
export type AsyncUnsubscribe = () => Promise<void>
