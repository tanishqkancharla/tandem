export class ReconnectError extends Error {
    constructor(message = "Unable to reconnect to Tandem remote") {
        super(message);
        this.name = "ReconnectError";
    }
}
export class TransientNetworkError extends Error {
    constructor(message = "Transient Tandem network error") {
        super(message);
        this.name = "TransientNetworkError";
    }
}
//# sourceMappingURL=errors.js.map