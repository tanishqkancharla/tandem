import type { AnyCollectionDefinition, AnyCollectionSchema, AnyRuntimeFieldDefinition, AnySchema, CollectionName, CollectionDefinition, NormalizedManyToOneRelationDefinition, NormalizedOneToManyRelationDefinition, RelationType, RuntimeFieldDefinition, RuntimeSchemaDefinition } from "../types";
import type { Codec } from "../utils/Codec";
type CollectionOptions<Record extends AnyCollectionSchema, StorageValue> = {
    codec?: Codec<Record, StorageValue>;
    fields?: readonly (keyof Record & string)[];
};
type CollectionShape = Record<string, AnyRuntimeFieldDefinition> & {
    id: RuntimeFieldDefinition<string | number>;
};
type RecordFromShape<Shape extends CollectionShape> = {
    [Field in keyof Shape & string]: Shape[Field] extends RuntimeFieldDefinition<infer Value> ? Value : never;
} & {
    id: string | number;
};
type SchemaFromCollections<Collections extends Record<string, AnyCollectionDefinition>> = {
    [Name in keyof Collections & string]: Collections[Name] extends CollectionDefinition<infer Record, any> ? Record : never;
};
type NamedCollections<Collections extends Record<string, AnyCollectionDefinition>> = {
    readonly [Name in keyof Collections & string]: Collections[Name] extends CollectionDefinition<infer Record, infer CollectionCodec> ? CollectionDefinition<Record, CollectionCodec> & {
        readonly name: Name;
    } : never;
};
export declare const t: {
    id: () => RuntimeFieldDefinition<string>;
    string: () => RuntimeFieldDefinition<string>;
    number: () => RuntimeFieldDefinition<number>;
    boolean: () => RuntimeFieldDefinition<boolean>;
};
export declare function collection<const Shape extends CollectionShape, StorageValue = unknown>(shape: Shape, options?: {
    codec?: Codec<RecordFromShape<Shape>, StorageValue>;
}): CollectionDefinition<RecordFromShape<Shape>, Codec<RecordFromShape<Shape>, StorageValue>>;
export declare function collection<Record extends AnyCollectionSchema, StorageValue = unknown>(options?: CollectionOptions<Record, StorageValue>): CollectionDefinition<Record, Codec<Record, StorageValue>>;
export declare function defineSchema<const Collections extends Record<string, AnyCollectionDefinition>>(collections: Collections): RuntimeSchemaDefinition<SchemaFromCollections<Collections>> & {
    readonly collections: NamedCollections<Collections>;
};
type RelationRegistration<Type extends RelationType = RelationType, TargetCollection extends string = string, From extends string = string, To extends string = string> = {
    readonly type: Type;
    readonly targetCollection: TargetCollection;
    readonly from: From;
    readonly to: To;
};
type RelationRegistrations<Schema extends AnySchema> = {
    readonly [SourceCollection in CollectionName<Schema>]?: {
        readonly [RelationName in string]?: RelationRegistration<"many-to-one", CollectionName<Schema>, keyof Schema[SourceCollection] & string, "id"> | RelationRegistration<"one-to-many", CollectionName<Schema>, "id", {
            [Collection in CollectionName<Schema>]: keyof Schema[Collection];
        }[CollectionName<Schema>] & string>;
    };
};
type RelationBuilderApi<Schema extends AnySchema> = {
    one: <const TargetCollection extends CollectionName<Schema>, const From extends string>(targetCollection: TargetCollection, join: {
        readonly from: From;
        readonly to: "id";
    }) => RelationRegistration<"many-to-one", TargetCollection, From, "id">;
    many: <const TargetCollection extends CollectionName<Schema>, const To extends keyof Schema[TargetCollection] & string>(targetCollection: TargetCollection, join: {
        readonly from: "id";
        readonly to: To;
    }) => RelationRegistration<"one-to-many", TargetCollection, "id", To>;
};
type NormalizeRelationRegistration<Schema extends AnySchema, SourceCollection extends CollectionName<Schema>, RelationName extends string, Relation extends RelationRegistration> = Relation extends RelationRegistration<infer Type, infer TargetCollection, any, any> ? TargetCollection extends CollectionName<Schema> ? Type extends "many-to-one" ? NormalizedManyToOneRelationDefinition<Schema, SourceCollection, TargetCollection, RelationName> : Type extends "one-to-many" ? NormalizedOneToManyRelationDefinition<Schema, SourceCollection, TargetCollection, RelationName> : never : never : never;
type NormalizedRelationsDefinition<Schema extends AnySchema, Relations extends RelationRegistrations<Schema>> = {
    readonly [SourceCollection in keyof Relations & CollectionName<Schema>]: {
        readonly [RelationName in keyof NonNullable<Relations[SourceCollection]> & string]: NonNullable<Relations[SourceCollection]>[RelationName] extends RelationRegistration ? NormalizeRelationRegistration<Schema, SourceCollection, RelationName, NonNullable<Relations[SourceCollection]>[RelationName]> : never;
    };
};
export declare function defineRelations<Schema extends AnySchema, const Relations extends RelationRegistrations<Schema>>(schema: RuntimeSchemaDefinition<Schema>, define: (builders: RelationBuilderApi<Schema>) => Relations): NormalizedRelationsDefinition<Schema, Relations>;
export {};
//# sourceMappingURL=Schema.d.ts.map