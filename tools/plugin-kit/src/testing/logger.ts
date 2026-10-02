import type { Logger } from '../logger.ts';

/** A logger that keeps every message with its level, for assertions. */
export class MemoryLogger implements Logger {
    readonly lines: string[] = [];

    info(message: string): void {
        this.lines.push(`info: ${message}`);
    }

    warn(message: string): void {
        this.lines.push(`warn: ${message}`);
    }

    error(message: string): void {
        this.lines.push(`error: ${message}`);
    }

    /** Messages of one level, without the level prefix. */
    of(level: 'info' | 'warn' | 'error'): string[] {
        return this.lines.filter((l) => l.startsWith(`${level}: `)).map((l) => l.slice(level.length + 2));
    }
}
