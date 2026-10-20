import * as scheduler from 'pumpkin:plugin/scheduler@0.1.0';
import { Plugin as CorePlugin, type TaskHandler } from './core.ts';
import { getTaskHandlerId, registerTaskHandler, releaseTaskHandler, trackTaskId } from './task-registry.ts';

const MAX_U64 = (1n << 64n) - 1n;

function validateTicks(value: number | bigint, name: string, minimum: bigint): bigint {
    if (typeof value !== 'number' && typeof value !== 'bigint') {
        throw new RangeError(`${name} must be a number or bigint.`);
    }

    if (typeof value === 'number' && !Number.isSafeInteger(value)) {
        throw new RangeError(`${name} must be a safe integer.`);
    }

    const ticks = BigInt(value);
    if (ticks < minimum || ticks > MAX_U64) {
        throw new RangeError(`${name} must be between ${minimum} and ${MAX_U64}.`);
    }

    return ticks;
}

/**
 * Base class for a Pumpkin plugin.
 *
 * Subclasses provide metadata and register their handlers with the context during `onLoad`.
 *
 * @example
 * ```typescript
 * import { Plugin, registerPlugin } from '@pumpkin-plugins/pumpkin-api';
 *
 * class ExamplePlugin extends Plugin {
 *     metadata() {
 *         return {
 *             name: 'example', version: '1.0.0', authors: ['Example'],
 *             description: 'An example plugin', dependencies: [], permissions: []
 *         };
 *     }
 * }
 *
 * registerPlugin(new ExamplePlugin());
 * ```
 */
export abstract class HostPlugin extends CorePlugin {
    /**
     * Schedule a task after a delay.
     *
     * @param delayTicks - Non-negative delay in server ticks, as a safe integer or u64 bigint.
     * @param handler - Callback invoked when the delay expires.
     * @returns The task ID returned by Pumpkin.
     * @throws {RangeError} When the delay is negative or is not a safe integer number or unsigned 64-bit bigint.
     */
    scheduleDelayedTask(delayTicks: number | bigint, handler: TaskHandler): number {
        const delay = validateTicks(delayTicks, 'delayTicks', 0n);
        const handlerId = registerTaskHandler(handler);
        try {
            const taskId = scheduler.scheduleDelayedTask(handlerId, delay);
            trackTaskId(handlerId, taskId);
            return taskId;
        } catch (error) {
            releaseTaskHandler(handlerId);
            throw error;
        }
    }

    /**
     * Schedule a repeating task.
     *
     * @param delayTicks - Non-negative delay before the first invocation, as a safe integer or u64 bigint.
     * @param periodTicks - Positive interval between invocations, as a safe integer or u64 bigint.
     * @param handler - Callback invoked on each scheduled tick.
     * @returns The task ID returned by Pumpkin.
     * @throws {RangeError} When either tick count is invalid or the period is not positive.
     */
    scheduleRepeatingTask(delayTicks: number | bigint, periodTicks: number | bigint, handler: TaskHandler): number {
        const delay = validateTicks(delayTicks, 'delayTicks', 0n);
        const period = validateTicks(periodTicks, 'periodTicks', 1n);
        const handlerId = registerTaskHandler(handler, true);
        try {
            const taskId = scheduler.scheduleRepeatingTask(handlerId, delay, period);
            trackTaskId(handlerId, taskId);
            return taskId;
        } catch (error) {
            releaseTaskHandler(handlerId);
            throw error;
        }
    }

    /**
     * Cancel a task scheduled through this facade and release its callback.
     *
     * @param taskId - ID returned by a scheduling helper. Completed or unknown IDs are ignored.
     * @throws Propagates host cancellation errors; the callback remains registered on failure.
     * @remarks Use this helper instead of the raw scheduler to release captured resources promptly.
     */
    cancelTask(taskId: number): void {
        const handlerId = getTaskHandlerId(taskId);
        if (handlerId === undefined) return;
        scheduler.cancelTask(taskId);
        releaseTaskHandler(handlerId);
    }
}
