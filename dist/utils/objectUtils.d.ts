export declare function isObject(value: unknown): value is Record<string, unknown>;
export declare function pick<T extends Record<string, unknown>, Keys extends keyof T>(object: T, keys: readonly Keys[]): Pick<T, Keys>;
export declare function pickBy<T extends Record<string, unknown>>(object: T, predicate: (value: T[keyof T]) => boolean): Partial<T>;
export declare function isEqual<T>(a: T, b: T): boolean;
export declare function partition<T, T1 extends T>(arr: readonly T[], predicate: (value: T) => value is T1): [T1[], Exclude<T, T1>[]];
export declare function reverse<T>(arr: readonly T[]): T[];
export declare function intersection<T>(a: readonly T[], b: readonly T[]): T[];
export declare function difference<T>(a: readonly T[], b: readonly T[]): T[];
export declare function isArray(value: unknown): value is any[];
export declare function isPlainObject(value: unknown): value is Record<string, unknown>;
export declare function isFunction(value: unknown): value is (...args: any[]) => any;
export declare function sortBy<T, V extends string | number>(arr: readonly T[], ...sortFns: (readonly [(item: T) => V, "asc" | "desc"])[]): T[];
export declare function isString(value: unknown): value is string;
export declare function mapValues<T extends Record<string, unknown>, V>(object: T, fn: (value: T[keyof T], key: keyof T) => V): {
    [K in keyof T]: V;
};
//# sourceMappingURL=objectUtils.d.ts.map