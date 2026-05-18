import { isEqual, partition, reverse } from "./utils/objectUtils.js";
export { tag, untag } from "./utils/typeUtils.js";
export var MutationApi;
(function (MutationApi) {
    function invertMutationOp(op) {
        switch (op.type) {
            case "set": {
                return "prevValue" in op
                    ? {
                        type: "set",
                        collection: op.collection,
                        value: op.prevValue,
                    }
                    : {
                        type: "remove",
                        collection: op.collection,
                        id: op.value.id,
                    };
            }
            case "remove": {
                return {
                    type: "set",
                    collection: op.collection,
                    value: op.value,
                };
            }
            default:
                throw new Error("Unknown mutation op type");
        }
    }
    function getRollbackWrites(mutations) {
        return WriteOpsApi.merge(...reverse(mutations)
            .map((mutation) => mutation.ops.map(invertMutationOp))
            .map(toWriteOps));
    }
    MutationApi.getRollbackWrites = getRollbackWrites;
    // This should probably live in database since it's tuple-specific
    function toWriteOps(ops) {
        const [setOps, removeOps] = partition(ops, (op) => op.type === "set");
        const writeOps = {
            set: setOps.map((op) => ({
                key: ["record", op.collection, op.value.id],
                value: op.value,
            })),
            remove: removeOps.map((op) => ["record", op.collection, op.id]),
        };
        return writeOps;
    }
    MutationApi.toWriteOps = toWriteOps;
    // export function mergeMutations<Schema extends AnySchema>(
    // 	mutations: readonly InvertibleMutation<Schema>[],
    // ): InvertibleMutation<Schema>
    // export function mergeMutations<Schema extends AnySchema>(
    // 	mutations: readonly Mutation<Schema>[],
    // ): Mutation<Schema>
    // export function mergeMutations<Schema extends AnySchema>(
    // 	mutations:
    // 		| readonly Mutation<Schema>[]
    // 		| readonly InvertibleMutation<Schema>[],
    // ): Mutation<Schema> | InvertibleMutation<Schema> {
    // 	const setOps = new Map<
    // 		string | number,
    // 		SetMutationOp<Schema> | InveribleSetMutationOp<Schema>
    // 	>()
    // 	const removeOps = new Map<
    // 		string | number,
    // 		RemoveMutationOp<Schema> | InveribleRemoveMutationOp<Schema>
    // 	>()
    // 	for (const mutation of mutations) {
    // 		for (const op of mutation.ops) {
    // 			if (op.type === "set") {
    // 				if (removeOps.has(op.value.id)) {
    // 					removeOps.delete(op.value.id)
    // 				}
    // 				setOps.set(op.value.id, op)
    // 			} else if (op.type === "remove") {
    // 				if (setOps.has(op.id)) {
    // 					setOps.delete(op.id)
    // 				}
    // 				removeOps.set(op.id, op)
    // 			}
    // 		}
    // 	}
    // 	return {
    // 		ops: [...setOps.values(), ...removeOps.values()],
    // 		id: tag(randomNumber().toString()),
    // 	}
    // }
    function opToDebugString(op) {
        switch (op.type) {
            case "set":
                return `set (${op.collection}) ${JSON.stringify(op.value, undefined, 2)}`;
            case "remove":
                return `remove (${op.collection}) ${op.id}`;
        }
    }
    function toString(mutation) {
        return `Mutation {\n${mutation.ops
            .map(opToDebugString)
            .map((s) => `  ${s}`)
            .join("\n")}\n}`;
    }
    MutationApi.toString = toString;
    function intersectsQuery(mutation, query) {
        for (const op of mutation.ops) {
            const { collection } = query;
            if (op.collection !== collection)
                continue;
            // TODO: use select and where
            return true;
        }
        return Object.values(query.with ?? {}).some((includedQuery) => intersectsQuery(mutation, includedQuery));
    }
    MutationApi.intersectsQuery = intersectsQuery;
    function intersectsScanWindow(mutation, scanWindow) {
        return scanWindow.some((query) => intersectsQuery(mutation, query));
    }
    MutationApi.intersectsScanWindow = intersectsScanWindow;
})(MutationApi || (MutationApi = {}));
export var WriteOpsApi;
(function (WriteOpsApi) {
    function toString(writeOps) {
        return `WriteOps {\n${writeOps.set
            ?.map((op) => `  set (${op.key[1]}) ${JSON.stringify(op.value, undefined, 2)}`)
            .join("\n") ?? ""}\n${writeOps.remove?.map((op) => `  remove (${op})`).join("\n") ?? ""}}`;
    }
    WriteOpsApi.toString = toString;
    function merge(...allWriteOps) {
        const target = {
            set: [],
            remove: [],
        };
        for (const { set = [], remove = [] } of allWriteOps) {
            for (const { key, value } of set) {
                // Filter out all the keys that we marked as set
                target.remove = target.remove?.filter((removedKey) => !isEqual(removedKey, key));
                target.set ??= [];
                target.set.push({ key, value });
            }
            for (const key of remove) {
                target.set = target.set?.filter(({ key: keySet }) => !isEqual(keySet, key));
                target.remove ??= [];
                target.remove.push(key);
            }
        }
        return target;
    }
    WriteOpsApi.merge = merge;
})(WriteOpsApi || (WriteOpsApi = {}));
export var PatchApi;
(function (PatchApi) {
    function toString(patch) {
        return `Patch {\n${patch.set
            ?.map((op) => `  set ${op.collection}.${op.value.id} = ${JSON.stringify(op.value)}`)
            .join("\n") ?? ""}\n${patch.remove?.map((op) => `  remove ${op.collection}.${op.id}`).join("\n") ?? ""}}`;
    }
    PatchApi.toString = toString;
    function toWriteOps(patch) {
        const set = [];
        const remove = [];
        for (const s of patch.set ?? []) {
            const key = ["record", s.collection, s.value.id];
            set.push({ key, value: s.value });
        }
        for (const r of patch.remove ?? []) {
            remove.push(["record", r.collection, r.id]);
        }
        return { set, remove };
    }
    PatchApi.toWriteOps = toWriteOps;
})(PatchApi || (PatchApi = {}));
//# sourceMappingURL=types.js.map