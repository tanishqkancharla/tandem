export type Codec<I, O> = {
    name: string;
    encode(input: unknown): O;
    decode(input: unknown): I;
};
export type AnyCodec = Codec<any, any>;
export type Encoded<T> = T extends Codec<any, infer O> ? O : never;
export type Decoded<T> = T extends Codec<infer I, any> ? I : never;
declare class CodecImpl<I, O> implements Codec<I, O> {
    readonly name: string;
    readonly internalEncode: (input: unknown) => O;
    readonly internalDecode: (input: unknown) => I;
    constructor(name: string, internalEncode: (input: unknown) => O, internalDecode: (input: unknown) => I);
    encode(input: unknown): O;
    decode(input: unknown): I;
}
export declare function codec<I, O>(name: string, encode: (input: unknown) => O, decode: (input: unknown) => I): Codec<I, O>;
export declare const string: CodecImpl<string, string>;
export declare function literal<T extends string | number | boolean>(value: T): Codec<T, T>;
export declare const date: CodecImpl<Date, string>;
export declare function object<T extends Record<string, AnyCodec>>(shape: T): Codec<{
    [K in keyof T]: Decoded<T[K]>;
}, {
    [K in keyof T]: Encoded<T[K]>;
}>;
export declare function oneOf<T extends AnyCodec[]>(...codecs: T): Codec<Decoded<T[number]>, Encoded<T[number]>>;
export {};
//# sourceMappingURL=Codec.d.ts.map