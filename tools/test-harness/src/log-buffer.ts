import { stripAnsi } from './util.ts';

/** How a wait for a log line ends when the line never comes. */
export interface WaitOptions {
    /** Give up after this many milliseconds. */
    timeoutMs: number;
    /** Only consider lines from this index on. */
    fromIndex: number;
    /** Whether the process has ended, so waiting is pointless. */
    isOver: () => boolean;
    /** What the process is, for the error message. */
    process: string;
}

/** Collects a process's output line by line, without color codes, and lets tests wait for a line. */
export class LogBuffer {
    /** Every non-blank line seen so far. */
    readonly lines: string[] = [];
    private waiters: Array<() => void> = [];

    /**
     * Starts collecting a stream.
     * @param stream - A process's stdout or stderr.
     */
    attach(stream: NodeJS.ReadableStream): void {
        let pending = '';
        stream.setEncoding('utf8');
        stream.on('data', (chunk: string) => {
            pending += chunk;
            const parts = pending.split(/\r?\n/);
            pending = parts.pop() ?? '';
            for (const part of parts) {
                const line = stripAnsi(part);
                if (line.trim()) this.lines.push(line);
            }
            this.notify();
        });
    }

    /** Wakes everything that is waiting so it can look again. Call when the process state changes. */
    notify(): void {
        const waiters = this.waiters;
        this.waiters = [];
        for (const wake of waiters) wake();
    }

    /**
     * Waits for a line to match.
     * @param pattern - What to look for.
     * @param options - When to give up.
     * @returns The first matching line.
     * @throws {Error} When the process ends or the time runs out first, with the last output attached.
     */
    async waitFor(pattern: RegExp, options: WaitOptions): Promise<string> {
        const deadline = Date.now() + options.timeoutMs;
        for (;;) {
            const hit = this.lines.slice(options.fromIndex).find((l) => pattern.test(l));
            if (hit) return hit;
            if (options.isOver())
                throw new Error(`${options.process} exited before ${pattern} appeared\n${this.tail()}`);
            const remaining = deadline - Date.now();
            if (remaining <= 0) {
                throw new Error(`Timed out after ${options.timeoutMs} ms waiting for ${pattern}\n${this.tail()}`);
            }
            await new Promise<void>((resolve) => {
                const timer = setTimeout(resolve, remaining);
                this.waiters.push(() => {
                    clearTimeout(timer);
                    resolve();
                });
            });
        }
    }

    /**
     * The last lines of output.
     * @param count - How many lines.
     * @returns A block of text for error messages.
     */
    tail(count = 40): string {
        return `--- last server output ---\n${this.lines.slice(-count).join('\n')}`;
    }

    /**
     * All output.
     * @returns Every line joined with newlines.
     */
    text(): string {
        return this.lines.join('\n');
    }
}
