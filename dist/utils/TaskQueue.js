export class TaskQueue {
    tasks;
    interval;
    timer;
    queue = [];
    queuedItems = new Map();
    drainPromise;
    constructor(tasks, interval, timer) {
        this.tasks = tasks;
        this.interval = interval;
        this.timer = timer;
    }
    enqueue(name) {
        const queuedItem = this.queuedItems.get(name);
        if (queuedItem)
            return queuedItem.promise;
        const item = this.createItem(name);
        this.queuedItems.set(name, item);
        this.queue.push(item);
        this.drainPromise ??= this.drain();
        return item.promise;
    }
    createItem(name) {
        let resolve;
        let reject;
        const promise = new Promise((resolvePromise, rejectPromise) => {
            resolve = resolvePromise;
            reject = rejectPromise;
        });
        return { name, promise, resolve, reject };
    }
    async drain() {
        try {
            await this.timer.delay(this.interval);
            while (this.queue.length > 0) {
                const item = this.queue.shift();
                if (!item)
                    continue;
                this.queuedItems.delete(item.name);
                try {
                    await this.tasks[item.name]();
                    item.resolve();
                }
                catch (error) {
                    item.reject(error);
                }
            }
        }
        finally {
            this.drainPromise = undefined;
            if (this.queue.length > 0) {
                this.drainPromise = this.drain();
            }
        }
    }
}
//# sourceMappingURL=TaskQueue.js.map