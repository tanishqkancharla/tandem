export function isObject(value) {
    return typeof value === "object" && value !== null;
}
export function pick(object, keys) {
    const result = {};
    for (const key of keys) {
        result[key] = object[key];
    }
    return result;
}
export function pickBy(object, predicate) {
    return Object.fromEntries(Object.entries(object).filter(([_key, value]) => predicate(value)));
}
export function isEqual(a, b) {
    if (a == b) {
        return true;
    }
    return JSON.stringify(a) === JSON.stringify(b);
}
export function partition(arr, predicate) {
    const trueArr = [];
    const falseArr = [];
    for (const value of arr) {
        if (predicate(value)) {
            trueArr.push(value);
        }
        else {
            falseArr.push(value);
        }
    }
    return [trueArr, falseArr];
}
export function reverse(arr) {
    return [...arr].reverse();
}
export function intersection(a, b) {
    return a.filter((value) => b.includes(value));
}
export function difference(a, b) {
    return a.filter((value) => !b.includes(value));
}
export function isArray(value) {
    return Array.isArray(value);
}
export function isPlainObject(value) {
    return isObject(value) && value.constructor === Object;
}
export function isFunction(value) {
    return typeof value === "function";
}
export function sortBy(arr, ...sortFns) {
    return [...arr].sort((a, b) => {
        for (const [sortFn, order] of sortFns) {
            const aValue = sortFn(a);
            const bValue = sortFn(b);
            if (aValue > bValue) {
                return order === "asc" ? 1 : -1;
            }
            else if (aValue < bValue) {
                return order === "asc" ? -1 : 1;
            }
        }
        return 0;
    });
}
export function isString(value) {
    return typeof value === "string";
}
export function mapValues(object, fn) {
    const result = {};
    for (const key in object) {
        result[key] = fn(object[key], key);
    }
    return result;
}
//# sourceMappingURL=objectUtils.js.map