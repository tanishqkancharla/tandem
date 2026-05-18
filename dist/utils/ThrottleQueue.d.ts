import type { TimerApi } from "../types.js";
export declare class ThrottleQueue {
    private readonly task;
    private readonly interval;
    private readonly timer;
    private taskPromise;
    constructor(task: () => Promise<void>, interval: number, timer: TimerApi);
    /**
     * Returns a shared promise for the currently queued batch.
     */
    enqueue(): Promise<void>;
    /**
     * If a batch is queued, immediately execute it without waiting for the
     * throttle delay. No-op when nothing is pending.
     */
    flush(): Promise<void>;
}
//# sourceMappingURL=ThrottleQueue.d.ts.map