function field(type) {
    return {
        kind: "field",
        type,
    };
}
function isFieldDefinition(value) {
    return (typeof value === "object" &&
        value !== null &&
        "kind" in value &&
        value.kind === "field");
}
function isCollectionShape(value) {
    return (typeof value === "object" &&
        value !== null &&
        Object.values(value).every(isFieldDefinition));
}
export const t = {
    id: () => field("id"),
    string: () => field("string"),
    number: () => field("number"),
    boolean: () => field("boolean"),
};
export function collection(shapeOrOptions = {}, options = {}) {
    if (isCollectionShape(shapeOrOptions)) {
        return {
            kind: "collection",
            codec: options.codec,
            shape: shapeOrOptions,
            fields: Object.keys(shapeOrOptions),
        };
    }
    return {
        kind: "collection",
        codec: shapeOrOptions.codec,
        fields: shapeOrOptions.fields,
    };
}
export function defineSchema(collections) {
    const namedCollections = Object.fromEntries(Object.entries(collections).map(([name, definition]) => [
        name,
        {
            ...definition,
            name,
        },
    ]));
    return {
        collections: namedCollections,
    };
}
function requireRuntimeFields(schema, collectionName) {
    const fields = schema.collections[collectionName].fields;
    if (!fields) {
        throw new Error(`Cannot validate relations for collection "${collectionName}" because it has no runtime fields. Use collection<...>({ fields: [...] }).`);
    }
    return new Set(fields);
}
export function defineRelations(schema, define) {
    const rawRelations = define({
        one: (targetCollection, join) => ({
            type: "many-to-one",
            targetCollection,
            from: join.from,
            to: join.to,
        }),
        many: (targetCollection, join) => ({
            type: "one-to-many",
            targetCollection,
            from: join.from,
            to: join.to,
        }),
    });
    const normalized = {};
    for (const [sourceCollectionName, relations] of Object.entries(rawRelations)) {
        const sourceCollection = sourceCollectionName;
        if (!(sourceCollection in schema.collections)) {
            throw new Error(`Unknown source collection "${sourceCollection}"`);
        }
        const sourceFields = requireRuntimeFields(schema, sourceCollection);
        const normalizedForSource = {
            ...(normalized[sourceCollection] ?? {}),
        };
        for (const [relationName, relation] of Object.entries(relations ?? {})) {
            if (!relation)
                continue;
            const relationPath = `${sourceCollection}.${relationName}`;
            if (normalizedForSource[relationName]) {
                throw new Error(`Duplicate relation "${relationPath}"`);
            }
            if (sourceFields.has(relationName)) {
                throw new Error(`Relation "${relationPath}" collides with field "${relationName}" on collection "${sourceCollection}"`);
            }
            if (!(relation.targetCollection in schema.collections)) {
                throw new Error(`Unknown target collection "${relation.targetCollection}" for relation "${relationPath}"`);
            }
            const targetCollection = relation.targetCollection;
            const targetFields = requireRuntimeFields(schema, targetCollection);
            if (!sourceFields.has(relation.from)) {
                throw new Error(`Missing source field "${relation.from}" for relation "${relationPath}" on collection "${sourceCollection}"`);
            }
            if (relation.type === "many-to-one" && relation.to !== "id") {
                throw new Error(`Relation "${relationPath}" must target the related record id; expected to="id", got to="${relation.to}"`);
            }
            if (relation.type === "one-to-many" && relation.from !== "id") {
                throw new Error(`Relation "${relationPath}" must start from the source record id; expected from="id", got from="${relation.from}"`);
            }
            if (!targetFields.has(relation.to)) {
                throw new Error(`Missing target field "${relation.to}" for relation "${relationPath}" on collection "${targetCollection}"`);
            }
            normalizedForSource[relationName] = {
                type: relation.type,
                name: relationName,
                sourceCollection,
                targetCollection: relation.targetCollection,
                from: relation.from,
                to: relation.to,
            };
        }
        normalized[sourceCollection] = normalizedForSource;
    }
    return normalized;
}
//# sourceMappingURL=Schema.js.map