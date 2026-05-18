import type { AsyncTupleStorageApi, WriteOps } from "tuple-database";
import { AsyncUnsubscribe, Tagged } from "./utils/typeUtils.js";
export { tag, untag } from "./utils/typeUtils.js";
export interface StorageApi extends AsyncTupleStorageApi {
    clear(): Promise<void>;
}
export type AnyCollectionSchema = Record<string, any> & {
    id: string | number;
};
declare const collectionRecord: unique symbol;
declare const fieldValue: unique symbol;
export type RuntimeFieldDefinition<Value = unknown> = {
    readonly kind: "field";
    readonly type: string;
    readonly [fieldValue]?: Value;
};
export type AnyRuntimeFieldDefinition = RuntimeFieldDefinition<any>;
export type CollectionDefinition<CollectionRecord extends AnyCollectionSchema = AnyCollectionSchema, CollectionCodec = unknown> = {
    readonly kind: "collection";
    readonly name?: string;
    readonly codec?: CollectionCodec;
    readonly shape?: globalThis.Record<string, AnyRuntimeFieldDefinition>;
    readonly fields?: readonly (keyof CollectionRecord & string)[];
    readonly [collectionRecord]?: CollectionRecord;
};
export type NamedCollectionDefinition<Record extends AnyCollectionSchema = AnyCollectionSchema, Name extends string = string, CollectionCodec = unknown> = CollectionDefinition<Record, CollectionCodec> & {
    readonly name: Name;
};
export type AnyCollectionDefinition = CollectionDefinition<AnyCollectionSchema, unknown>;
export type RuntimeSchemaDefinition<Schema extends AnySchema = AnySchema> = {
    readonly collections: {
        readonly [Collection in CollectionName<Schema>]: NamedCollectionDefinition<Schema[Collection], Collection, unknown>;
    };
};
export type RelationType = "many-to-one" | "one-to-many";
export type NormalizedManyToOneRelationDefinition<Schema extends AnySchema = AnySchema, SourceCollection extends CollectionName<Schema> = CollectionName<Schema>, TargetCollection extends CollectionName<Schema> = CollectionName<Schema>, RelationName extends string = string> = {
    readonly type: "many-to-one";
    readonly name: RelationName;
    readonly sourceCollection: SourceCollection;
    readonly targetCollection: TargetCollection;
    readonly from: keyof Schema[SourceCollection] & string;
    readonly to: "id";
};
export type NormalizedOneToManyRelationDefinition<Schema extends AnySchema = AnySchema, SourceCollection extends CollectionName<Schema> = CollectionName<Schema>, TargetCollection extends CollectionName<Schema> = CollectionName<Schema>, RelationName extends string = string> = {
    readonly type: "one-to-many";
    readonly name: RelationName;
    readonly sourceCollection: SourceCollection;
    readonly targetCollection: TargetCollection;
    readonly from: "id";
    readonly to: keyof Schema[TargetCollection] & string;
};
export type NormalizedRelationDefinition<Schema extends AnySchema = AnySchema, SourceCollection extends CollectionName<Schema> = CollectionName<Schema>, TargetCollection extends CollectionName<Schema> = CollectionName<Schema>, RelationName extends string = string> = NormalizedManyToOneRelationDefinition<Schema, SourceCollection, TargetCollection, RelationName> | NormalizedOneToManyRelationDefinition<Schema, SourceCollection, TargetCollection, RelationName>;
export type RuntimeRelationsDefinition<Schema extends AnySchema = AnySchema> = {
    readonly [SourceCollection in CollectionName<Schema>]?: {
        readonly [RelationName in string]?: NormalizedRelationDefinition<Schema, SourceCollection, CollectionName<Schema>, RelationName>;
    };
};
export type Attribute<Schema extends AnySchema> = {
    [K in keyof Schema]: keyof Schema[K];
}[keyof Schema] & string;
export type AnySchema = Record<string, AnyCollectionSchema>;
export type CollectionName<Schema extends AnySchema> = keyof Schema & string;
export type FieldWhereOperators<Value> = {
    readonly eq?: Value;
    readonly gt?: Value;
    readonly lt?: Value;
    readonly gte?: Value;
    readonly lte?: Value;
};
export type RelationalSelectOptions<Schema extends AnySchema, Collection extends CollectionName<Schema>> = {
    readonly [Field in keyof Schema[Collection] & string]?: true;
};
export type RelationalWhereOptions<Schema extends AnySchema, Collection extends CollectionName<Schema>> = {
    readonly [Field in keyof Schema[Collection] & string]?: Schema[Collection][Field] | FieldWhereOperators<Schema[Collection][Field]>;
};
export type RelationalOrderByOptions<Schema extends AnySchema, Collection extends CollectionName<Schema>> = {
    readonly [Field in keyof Schema[Collection] & string]?: "asc" | "desc";
};
type RelationTargetCollection<Relation> = Relation extends {
    readonly targetCollection: infer TargetCollection;
} ? TargetCollection : never;
type RelationTypeForResult<Relation> = Relation extends {
    readonly type: infer Type;
} ? Type : never;
export type RelationalWithOptions<Schema extends AnySchema, Relations extends RuntimeRelationsDefinition<Schema>, Collection extends CollectionName<Schema>> = {
    readonly [RelationName in keyof NonNullable<Relations[Collection]> & string]?: true | RelationalQueryOptions<Schema, Relations, RelationTargetCollection<NonNullable<Relations[Collection]>[RelationName]> & CollectionName<Schema>>;
};
export type RelationalQueryOptions<Schema extends AnySchema, Relations extends RuntimeRelationsDefinition<Schema>, Collection extends CollectionName<Schema>> = {
    readonly select?: RelationalSelectOptions<Schema, Collection>;
    readonly where?: RelationalWhereOptions<Schema, Collection>;
    readonly with?: RelationalWithOptions<Schema, Relations, Collection>;
    readonly orderBy?: RelationalOrderByOptions<Schema, Collection>;
    readonly limit?: number;
    readonly offset?: number;
};
export type RelationalQuery<Schema extends AnySchema, Relations extends RuntimeRelationsDefinition<Schema>, Collection extends CollectionName<Schema> = CollectionName<Schema>> = Collection extends CollectionName<Schema> ? {
    readonly collection: Collection;
} & RelationalQueryOptions<Schema, Relations, Collection> : never;
type SelectedScalarKeys<Schema extends AnySchema, Collection extends CollectionName<Schema>, Select> = keyof {
    readonly [Field in keyof Schema[Collection] & string as Select extends {
        readonly [Key in Field]?: true;
    } ? Field : never]: true;
};
export type RelationalQueryRow<Schema extends AnySchema, Relations extends RuntimeRelationsDefinition<Schema>, Collection extends CollectionName<Schema>, Options extends RelationalQueryOptions<Schema, Relations, Collection> = {}> = RelationalQueryScalars<Schema, Collection, Options> & RelationalQueryIncludedRelations<Schema, Relations, Collection, Options>;
type RelationalQueryScalars<Schema extends AnySchema, Collection extends CollectionName<Schema>, Options extends {
    readonly select?: RelationalSelectOptions<Schema, Collection>;
}> = Options extends {
    readonly select: infer Select;
} ? Pick<Schema[Collection], SelectedScalarKeys<Schema, Collection, Select> & keyof Schema[Collection]> : Schema[Collection];
type RelationalQueryIncludedRelations<Schema extends AnySchema, Relations extends RuntimeRelationsDefinition<Schema>, Collection extends CollectionName<Schema>, Options extends RelationalQueryOptions<Schema, Relations, Collection>> = Options extends {
    readonly with: infer With;
} ? {
    readonly [RelationName in keyof With & keyof NonNullable<Relations[Collection]> & string]: RelationalIncludedRelationResult<Schema, Relations, NonNullable<Relations[Collection]>[RelationName], With[RelationName]>;
} : {};
type RelationalIncludedRelationResult<Schema extends AnySchema, Relations extends RuntimeRelationsDefinition<Schema>, Relation, Include> = RelationTargetCollection<Relation> extends CollectionName<Schema> ? RelationTypeForResult<Relation> extends "many-to-one" ? RelationalQueryRow<Schema, Relations, RelationTargetCollection<Relation> & CollectionName<Schema>, RelationalIncludedRelationOptions<Schema, Relations, RelationTargetCollection<Relation> & CollectionName<Schema>, Include>> | null : RelationTypeForResult<Relation> extends "one-to-many" ? RelationalQueryRow<Schema, Relations, RelationTargetCollection<Relation> & CollectionName<Schema>, RelationalIncludedRelationOptions<Schema, Relations, RelationTargetCollection<Relation> & CollectionName<Schema>, Include>>[] : never : never;
type RelationalIncludedRelationOptions<Schema extends AnySchema, Relations extends RuntimeRelationsDefinition<Schema>, Collection extends CollectionName<Schema>, Include> = Include extends true ? {} : Include extends RelationalQueryOptions<Schema, Relations, Collection> ? Include : never;
type RelationalQueryResultForOptions<Schema extends AnySchema, Relations extends RuntimeRelationsDefinition<Schema>, Collection extends CollectionName<Schema>, Options extends RelationalQueryOptions<Schema, Relations, Collection> = {}> = RelationalQueryRow<Schema, Relations, Collection, Options>[];
export type RelationalQueryResult<Schema extends AnySchema, Relations extends RuntimeRelationsDefinition<Schema>, Query extends RelationalQuery<Schema, Relations>> = RelationalQueryResultForOptions<Schema, Relations, Query["collection"] & CollectionName<Schema>, Query>;
export type QueryResults<Schema extends AnySchema, Relations extends RuntimeRelationsDefinition<Schema>, Query extends RelationalQuery<Schema, Relations>> = RelationalQueryResult<Schema, Relations, Query>;
export type Thenable<T> = T | PromiseLike<T>;
export type ClientId = Tagged<"ClientId", string>;
export type Cookie = Tagged<"Cookie", number | string>;
export type ClientApi = {
    clientId: ClientId;
    poke: () => void;
};
export type ScanWindow<Schema extends AnySchema> = EncodedQuery<Schema>[];
export type RemoteApi<Schema extends AnySchema> = {
    connect(api: ClientApi): Promise<AsyncUnsubscribe>;
    push(args: {
        mutations: Mutation<Schema>[];
        clientId: ClientId;
    }): Promise<void>;
    pull(args: {
        clientId: ClientId;
        cookie?: Cookie;
        scanWindow: ScanWindow<Schema>;
    }): Promise<{
        cookie: Cookie;
        patch: Patch<Schema>;
        lastMutationId?: MutationId;
    }>;
};
export type RngApi = {
    randomId: () => string;
};
export type TimerApi = {
    delay: (ms: number) => Promise<void>;
};
export type InveribleSetMutationOp<Schema extends AnySchema> = {
    type: "set";
} & {
    [Collection in CollectionName<Schema>]: {
        collection: Collection;
        value: Schema[Collection];
        prevValue?: Schema[Collection];
    };
}[CollectionName<Schema>];
export type InveribleRemoveMutationOp<Schema extends AnySchema> = {
    type: "remove";
} & {
    [Collection in CollectionName<Schema>]: {
        collection: Collection;
        id: string | number;
        value: Schema[Collection];
    };
}[CollectionName<Schema>];
export type SetMutationOp<Schema extends AnySchema> = {
    type: "set";
} & {
    [Collection in CollectionName<Schema>]: {
        collection: Collection;
        value: Schema[Collection];
    };
}[CollectionName<Schema>];
export type RemoveMutationOp<Schema extends AnySchema> = {
    type: "remove";
} & {
    [Collection in CollectionName<Schema>]: {
        collection: Collection;
        id: Schema[Collection]["id"];
    };
}[CollectionName<Schema>];
export type InvertibleMutationOp<Schema extends AnySchema> = InveribleSetMutationOp<Schema> | InveribleRemoveMutationOp<Schema>;
export type MutationOp<Schema extends AnySchema> = SetMutationOp<Schema> | RemoveMutationOp<Schema>;
export type MutationId = Tagged<"MutationId", string>;
export type Mutation<Schema extends AnySchema> = {
    ops: MutationOp<Schema>[];
    id: MutationId;
};
export type InvertibleMutation<Schema extends AnySchema> = {
    ops: InvertibleMutationOp<Schema>[];
    id: MutationId;
};
export type EncodedWhereClause<Schema extends AnySchema, Collection extends CollectionName<Schema>> = {
    [Field in keyof Schema[Collection] & string]: [
        attribute: Field,
        operator: Operator,
        value: Schema[Collection][Field]
    ];
}[keyof Schema[Collection] & string];
export type EncodedQuery<Schema extends AnySchema, Collection extends CollectionName<Schema> = CollectionName<Schema>> = {
    collection: Collection;
    select?: readonly (keyof Schema[Collection] & string)[] | "*";
    where?: EncodedWhereClause<Schema, Collection>[];
    order?: [
        attribute: keyof Schema[Collection] & string,
        direction: "asc" | "desc"
    ][];
    limit?: number;
    offset?: number;
    with?: Record<string, EncodedQuery<Schema>>;
};
export type Operator = "=" | ">" | "<" | ">=" | "<=";
export declare namespace MutationApi {
    function getRollbackWrites<Schema extends AnySchema>(mutations: readonly InvertibleMutation<Schema>[]): WriteOps;
    function toWriteOps(ops: MutationOp<any>[]): WriteOps;
    function toString<Schema extends AnySchema>(mutation: Mutation<Schema>): string;
    function intersectsQuery<Schema extends AnySchema>(mutation: Mutation<Schema>, query: EncodedQuery<Schema>): boolean;
    function intersectsScanWindow<Schema extends AnySchema>(mutation: Mutation<Schema>, scanWindow: ScanWindow<Schema>): boolean;
}
export declare namespace WriteOpsApi {
    function toString(writeOps: WriteOps): string;
    function merge(...allWriteOps: WriteOps[]): WriteOps;
}
export declare namespace PatchApi {
    function toString<Schema extends AnySchema>(patch: Patch<Schema>): string;
    function toWriteOps<Schema extends AnySchema>(patch: Patch<Schema>): WriteOps;
}
export type SchemaToTupleSchema<Schema extends AnySchema> = {
    [C in CollectionName<Schema>]: {
        key: ["record", collection: C, id: Schema[C]["id"]];
        value: Schema[C];
    };
}[CollectionName<Schema>];
export type Json = string | number | boolean | null | Json[] | {
    [key: string]: Json;
};
export type PatchSetOp<Schema extends AnySchema> = {
    [Collection in CollectionName<Schema>]: {
        collection: Collection;
        value: Schema[Collection];
    };
}[CollectionName<Schema>];
export type PatchRemoveOp<Schema extends AnySchema> = {
    [Collection in CollectionName<Schema>]: {
        collection: Collection;
        id: Schema[Collection]["id"];
    };
}[CollectionName<Schema>];
export type Patch<Schema extends AnySchema = AnySchema> = {
    set?: PatchSetOp<Schema>[];
    remove?: PatchRemoveOp<Schema>[];
};
//# sourceMappingURL=types.d.ts.map