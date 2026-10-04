/**
 * A piece of work written as a generator: it yields while it waits for the network and returns
 * its result. Nothing here needs promises or timers, so it runs inside a game tick.
 */
export type Steps<T> = Generator<void, T, void>;

/** Where a task stands. */
export type TaskState<T> = { state: 'running' } | { state: 'done'; value: T } | { state: 'failed'; error: Error };

/** Runs `Steps` one step per `poll`. */
export class Task<T> {
    private result: TaskState<T> = { state: 'running' };

    /** Wraps the steps. Nothing runs until `poll`. */
    constructor(private readonly steps: Steps<T>) {}

    /** Runs the work up to its next wait, and reports where it stands. */
    poll(): TaskState<T> {
        if (this.result.state !== 'running') return this.result;
        try {
            const next = this.steps.next();
            if (next.done) this.result = { state: 'done', value: next.value };
        } catch (err) {
            this.result = { state: 'failed', error: err instanceof Error ? err : new Error(String(err)) };
        }
        return this.result;
    }

    /** Stops the work and lets it clean up (its `finally` blocks run). */
    cancel(): void {
        if (this.result.state !== 'running') return;
        this.result = { state: 'failed', error: new Error('canceled') };
        try {
            this.steps.return(undefined as T);
        } catch {
            // Cleanup that fails has nowhere to report to.
        }
    }
}

/** What one of several parallel jobs came to. */
export type Settled<T> = { ok: true; value: T } | { ok: false; error: Error };

/**
 * Runs jobs side by side, one step of each per round.
 * @returns How each job ended, in the order given. It never throws.
 */
export function* parallel<T>(jobs: Steps<T>[]): Steps<Settled<T>[]> {
    const tasks = jobs.map((job) => new Task(job));
    try {
        for (;;) {
            const states = tasks.map((task) => task.poll());
            if (states.every((s) => s.state !== 'running')) {
                return states.map((s): Settled<T> => {
                    if (s.state === 'done') return { ok: true, value: s.value };
                    return { ok: false, error: s.state === 'failed' ? s.error : new Error('canceled') };
                });
            }
            yield;
        }
    } finally {
        for (const task of tasks) task.cancel();
    }
}
