import { isObject, isString, mapValues } from "./objectUtils.js";
class CodecImpl {
    name;
    internalEncode;
    internalDecode;
    constructor(name, internalEncode, internalDecode) {
        this.name = name;
        this.internalEncode = internalEncode;
        this.internalDecode = internalDecode;
    }
    encode(input) {
        return this.internalEncode(input);
    }
    decode(input) {
        return this.internalDecode(input);
    }
}
export function codec(name, encode, decode) {
    return new CodecImpl(name, encode, decode);
}
export const string = new CodecImpl("string", (input) => {
    if (!isString(input)) {
        throw new Error(`Expected string but instead found ${typeof input}`);
    }
    return input;
}, (input) => {
    if (!isString(input)) {
        throw new Error(`Expected string but instead found ${typeof input}`);
    }
    return input;
});
export function literal(value) {
    return new CodecImpl(`literal(${value})`, (encoded) => {
        if (encoded !== value) {
            throw new Error(`Expected ${value} but instead found ${encoded}`);
        }
        return encoded;
    }, (input) => {
        if (input !== value) {
            throw new Error(`Expected ${value} but instead found ${input}`);
        }
        return input;
    });
}
export const date = new CodecImpl("date", (input) => {
    if (!(input instanceof Date)) {
        throw new Error(`Expected date but instead found ${typeof input}`);
    }
    return input.toISOString();
}, (input) => {
    if (!isString(input)) {
        throw new Error(`Expected string but instead found ${typeof input}`);
    }
    return new Date(input);
});
export function object(shape) {
    return new CodecImpl(`object({\n  ${Object.entries(shape)
        .map(([key, codec]) => `${key}: ${codec.name}`)
        .join(",\n  ")}\n})`, (input) => {
        if (!isObject(input)) {
            throw new Error(`Expected object but instead found ${typeof input}`);
        }
        return mapValues(input, (value, key) => shape[key].encode(value));
    }, (input) => {
        if (!isObject(input)) {
            throw new Error(`Expected object but instead found ${typeof input}`);
        }
        return mapValues(input, (value, key) => shape[key].decode(value));
    });
}
export function oneOf(...codecs) {
    return new CodecImpl(`oneOf(\n  ${codecs.map((c) => c.name).join(",\n  ")}\n)`, (input) => {
        const errors = [];
        for (const codec of codecs) {
            try {
                const encoded = codec.encode(input);
                if (encoded !== undefined) {
                    return encoded;
                }
            }
            catch (error) {
                errors.push(`${codec.name}: ${error}`);
            }
        }
        throw new Error(`No codec matched ${input}: \n${errors.join("\n")}`);
    }, (input) => {
        const errors = [];
        for (const codec of codecs) {
            try {
                return codec.decode(input);
            }
            catch (error) {
                errors.push(`${codec.name}: ${error}`);
            }
        }
        throw new Error(`No codec matched ${input}: \n${errors.join("\n")}`);
    });
}
//# sourceMappingURL=Codec.js.map