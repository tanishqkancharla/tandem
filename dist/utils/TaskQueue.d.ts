import type { TimerApi } from "../types";
export declare class TaskQueue<TaskName extends string> {
    private readonly tasks;
    private readonly interval;
    private readonly timer;
    private readonly queue;
    private readonly queuedItems;
    private drainPromise?;
    constructor(tasks: Record<TaskName, () => Promise<void>>, interval: number, timer: TimerApi);
    enqueue(name: TaskName): Promise<void>;
    private createItem;
    private drain;
}
//# sourceMappingURL=TaskQueue.d.ts.map