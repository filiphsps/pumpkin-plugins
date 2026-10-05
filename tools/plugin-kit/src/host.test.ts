import type { Server } from 'pumpkin:plugin/server@0.1.0';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const host = vi.hoisted(() => ({ delayed: vi.fn(), repeating: vi.fn(), cancel: vi.fn() }));
vi.mock('pumpkin:plugin/logging@0.1.0', () => ({ log: vi.fn() }));
vi.mock('pumpkin:plugin/scheduler@0.1.0', () => ({
    scheduleDelayedTask: host.delayed,
    scheduleRepeatingTask: host.repeating,
    cancelTask: host.cancel
}));

const server = {} as Server;
beforeEach(() => {
    vi.resetModules();
    vi.resetAllMocks();
});

describe('host scheduling', () => {
    it('runs repeating tasks until canceled and releases their callbacks', async () => {
        const { scheduleRepeating, cancelTask, runTask } = await import('./host.ts');
        host.repeating.mockReturnValue(41);
        const run = vi.fn();
        expect(scheduleRepeating(2, run)).toBe(41);
        const id = host.repeating.mock.calls[0][0];
        expect(host.repeating).toHaveBeenCalledWith(id, 2, 2);
        expect(runTask(id, server)).toBe(true);
        expect(runTask(id, server)).toBe(true);
        cancelTask(41);
        expect(host.cancel).toHaveBeenCalledWith(41);
        expect(runTask(id, server)).toBe(false);
        expect(run).toHaveBeenCalledTimes(2);
    });

    it('removes delayed tasks before running them, including when they throw', async () => {
        const { scheduleDelayed, runTask } = await import('./host.ts');
        host.delayed.mockReturnValue(42);
        const run = vi.fn(() => {
            throw new Error('callback failed');
        });
        expect(scheduleDelayed(0, run)).toBe(42);
        const id = host.delayed.mock.calls[0][0];
        expect(host.delayed).toHaveBeenCalledWith(id, 0);
        expect(() => runTask(id, server)).toThrow('callback failed');
        expect(runTask(id, server)).toBe(false);
        expect(run).toHaveBeenCalledOnce();
    });

    it('can cancel delayed tasks before they run', async () => {
        const { scheduleDelayed, cancelTask, runTask } = await import('./host.ts');
        host.delayed.mockReturnValue(42);
        const run = vi.fn();
        scheduleDelayed(1, run);
        cancelTask(42);
        expect(runTask(host.delayed.mock.calls[0][0], server)).toBe(false);
        expect(run).not.toHaveBeenCalled();
    });

    it('removes callbacks when submission fails', async () => {
        const { scheduleRepeating, scheduleDelayed, runTask } = await import('./host.ts');
        for (const [schedule, mock] of [
            [scheduleRepeating, host.repeating],
            [scheduleDelayed, host.delayed]
        ] as const) {
            mock.mockImplementation(() => {
                throw new Error('host failure');
            });
            expect(() => schedule(1, vi.fn())).toThrow('host failure');
            expect(runTask(mock.mock.calls[0][0], server)).toBe(false);
        }
    });

    it('retains callbacks if host cancellation fails', async () => {
        const { scheduleRepeating, cancelTask, runTask } = await import('./host.ts');
        host.repeating.mockReturnValue(41);
        scheduleRepeating(1, vi.fn());
        host.cancel.mockImplementation(() => {
            throw new Error('cancel failed');
        });
        expect(() => cancelTask(41)).toThrow('cancel failed');
        expect(runTask(host.repeating.mock.calls[0][0], server)).toBe(true);
    });

    it('keeps handler ids distinct after thousands of tasks', async () => {
        const { scheduleRepeating, scheduleDelayed, runTask } = await import('./host.ts');
        let taskId = 0;
        host.repeating.mockImplementation(() => ++taskId);
        host.delayed.mockImplementation(() => ++taskId);
        const repeated = vi.fn();
        const delayed = vi.fn();
        for (let i = 0; i <= 5000; i++) scheduleRepeating(1, repeated);
        scheduleDelayed(1, delayed);
        const delayedId = host.delayed.mock.calls[0][0];
        expect(host.repeating.mock.calls.some(([id]) => id === delayedId)).toBe(false);
        expect(runTask(delayedId, server)).toBe(true);
        expect(delayed).toHaveBeenCalledOnce();
        expect(repeated).not.toHaveBeenCalled();
    });

    it.each([-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])(
        'rejects invalid tick count %s before reaching the host',
        async (ticks) => {
            const { scheduleRepeating, scheduleDelayed } = await import('./host.ts');
            expect(() => scheduleDelayed(ticks, vi.fn())).toThrow(RangeError);
            expect(() => scheduleRepeating(ticks, vi.fn())).toThrow(RangeError);
            expect(host.delayed).not.toHaveBeenCalled();
            expect(host.repeating).not.toHaveBeenCalled();
        }
    );

    it('rejects a zero repeating period', async () => {
        const { scheduleRepeating } = await import('./host.ts');
        expect(() => scheduleRepeating(0, vi.fn())).toThrow(RangeError);
        expect(host.repeating).not.toHaveBeenCalled();
    });
});
