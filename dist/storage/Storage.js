export class Storage {
    adapter;
    onFailure;
    constructor(adapter, onFailure) {
        this.adapter = adapter;
        this.onFailure = onFailure;
    }
    async commit(writeOps) {
        try {
            await this.adapter.commit(writeOps);
        }
        catch (error) {
            this.onFailure(error);
            throw error;
        }
    }
    async scan(args) {
        // TODO: what should we do if this fails?
        return await this.adapter.scan(args);
    }
    async clear() {
        await this.adapter.clear();
    }
}
//# sourceMappingURL=Storage.js.map