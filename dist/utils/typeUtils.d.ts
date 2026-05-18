export type Json = string | number | boolean | null | Json[] | {
    [key: string]: Json;
};
export type AnyFunction = (...args: any[]) => any;
export type AnyAsyncFunction = (...args: any[]) => Promise<any>;
export type AnyFunctionMap = Record<string, AnyFunction>;
export type AnyAsyncFunctionMap = Record<string, AnyAsyncFunction>;
export type Caller<T extends AnyFunctionMap> = {
    [K in keyof T]: (...args: Parameters<T[K]>) => Promisify<ReturnType<T[K]>>;
};
export type Answerer<T extends AnyFunctionMap> = {
    [K in keyof T]: (fn: (...args: Parameters<T[K]>) => Awaited<ReturnType<T[K]>> | Promise<Awaited<ReturnType<T[K]>>>) => () => void;
};
export type Promisify<T> = T extends Promise<any> ? T : Promise<T>;
export type AsyncApi<Api extends AnyFunctionMap> = {
    [Key in keyof Api]: (...args: Parameters<Api[Key]>) => Promisify<ReturnType<Api[Key]>>;
};
export type Destructor = () => void;
export declare function joinDestructors(destructors: Destructor[]): () => void;
export type Callback<T> = (value: T) => void;
export type Span = [from: number, to: number];
export declare namespace Spans {
    function includes(reference: Span, test: Span): boolean;
}
export declare function unreachable(value: never): never;
export type Assert<_Test extends true> = void;
export type TestIsEqual<A extends B, B> = A extends B ? B extends A ? true : false : false;
export type TestExtends<A extends B, B> = A extends B ? true : false;
declare const tagSymbol: unique symbol;
export type Tagged<Tag extends string, T> = T & {
    [tagSymbol]: Tag;
};
export type Untagged<TagType> = TagType extends Tagged<any, infer T> ? T extends string ? string : T extends number ? number : Omit<TagType, typeof tagSymbol> : never;
export declare function tag<TagType extends Tagged<any, any>>(value: Untagged<TagType>): TagType;
export declare function untag<TagType extends Tagged<any, any>>(value: TagType): Untagged<TagType>;
export type Unsubscribe = () => void;
export type AsyncUnsubscribe = () => Promise<void>;
export {};
//# sourceMappingURL=typeUtils.d.ts.map