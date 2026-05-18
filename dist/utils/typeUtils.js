export function joinDestructors(destructors) {
    return () => {
        destructors.forEach((destructor) => destructor());
    };
}
export var Spans;
(function (Spans) {
    function includes(reference, test) {
        return reference[0] <= test[0] && reference[1] >= test[1];
    }
    Spans.includes = includes;
})(Spans || (Spans = {}));
export function unreachable(value) {
    throw new Error("Unreachable code reached: " + JSON.stringify(value));
}
const tagSymbol = Symbol("tag");
export function tag(value) {
    return value;
}
export function untag(value) {
    return value;
}
//# sourceMappingURL=typeUtils.js.map