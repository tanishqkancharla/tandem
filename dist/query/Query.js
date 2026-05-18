const whereOperatorMap = {
    eq: "=",
    gt: ">",
    lt: "<",
    gte: ">=",
    lte: "<=",
};
function isWhereOperatorObject(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
export function _encodeRelationalQuery(collection, options = {}, relations) {
    const encoded = { collection };
    if (options.select) {
        encoded.select = Object.keys(options.select);
    }
    if (options.where) {
        encoded.where = [];
        for (const [field, condition] of Object.entries(options.where)) {
            if (isWhereOperatorObject(condition)) {
                for (const [operator, value] of Object.entries(condition)) {
                    const encodedOperator = whereOperatorMap[operator];
                    if (!encodedOperator) {
                        throw new Error(`Unknown where operator "${operator}"`);
                    }
                    encoded.where.push([
                        field,
                        encodedOperator,
                        value,
                    ]);
                }
            }
            else {
                encoded.where.push([
                    field,
                    "=",
                    condition,
                ]);
            }
        }
    }
    if (options.orderBy) {
        encoded.order = [];
        for (const [field, direction] of Object.entries(options.orderBy)) {
            if (!direction)
                continue;
            encoded.order.push([field, direction]);
        }
    }
    if (options.limit !== undefined) {
        encoded.limit = options.limit;
    }
    if (options.offset !== undefined) {
        encoded.offset = options.offset;
    }
    if (options.with) {
        if (!relations) {
            throw new Error("Cannot encode relational query includes without relations");
        }
        encoded.with = {};
        const collectionRelations = relations[collection];
        for (const [relationName, relationOptions] of Object.entries(options.with)) {
            const relation = collectionRelations?.[relationName];
            if (!relation) {
                throw new Error(`Unknown relation "${collection}.${relationName}"`);
            }
            encoded.with[relationName] = _encodeRelationalQuery(relation.targetCollection, relationOptions === true ? {} : relationOptions, relations);
        }
    }
    return encoded;
}
//# sourceMappingURL=Query.js.map