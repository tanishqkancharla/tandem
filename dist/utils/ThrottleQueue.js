export class ThrottleQueue {
    task;
    interval;
    timer;
    taskPromise;
    constructor(task, interval, timer) {
        this.task = task;
        this.interval = interval;
        this.timer = timer;
    }
    /**
     * Returns a shared promise for the currently queued batch.
     */
    enqueue() {
        if (this.taskPromise)
            return this.taskPromise;
        this.taskPromise = this.timer.delay(this.interval).then(() => {
            const taskPromise = this.task();
            // If you queue once the task has already started running, it should go into a
            // new batch.
            this.taskPromise = undefined;
            return taskPromise;
        });
        return this.taskPromise;
    }
    /**
     * If a batch is queued, immediately execute it without waiting for the
     * throttle delay. No-op when nothing is pending.
     */
    async flush() {
        if (this.taskPromise) {
            this.taskPromise = undefined;
            await this.task();
        }
    }
}
//# sourceMappingURL=ThrottleQueue.js.map