import type { CommandSender, ConsumedArgs } from 'pumpkin:plugin/command@0.1.0';
import * as logging from 'pumpkin:plugin/logging@0.1.0';
import * as scheduler from 'pumpkin:plugin/scheduler@0.1.0';
import type { Server } from 'pumpkin:plugin/server@0.1.0';
import { HandlerRegistry } from './handlers.ts';
import type { Logger } from './logger.ts';

/** The server log, through the host's logging interface. */
export const hostLogger: Logger = {
    debug: (message) => logging.log('debug', message),
    info: (message) => logging.log('info', message),
    warn: (message) => logging.log('warn', message),
    error: (message) => logging.log('error', message)
};

// The base `Plugin` class can't be used for these: its scheduler calls pass `BigInt` where the
// runtime needs numbers, and its handler maps are private. Ids start far above the ones it hands out.
interface ScheduledHandler {
    run: (server: Server) => void;
    repeating: boolean;
    taskId?: number;
}

// One registry prevents delayed and repeating handler ids from overlapping.
const tasks = new HandlerRegistry<ScheduledHandler>(900_000);
const taskHandlers = new Map<number, number>();
const commandHandlers = new HandlerRegistry<(sender: CommandSender, args: ConsumedArgs) => number>(910_000);

/**
 * Runs a function every `periodTicks` game ticks, starting after the same delay.
 * @param periodTicks - Ticks between runs.
 * @param run - The function to run.
 * @returns The scheduler's task id, for `cancelTask`.
 */
export function scheduleRepeating(periodTicks: number, run: (server: Server) => void): number {
    validateTicks(periodTicks, 1);
    return schedule(run, true, (id) => scheduler.scheduleRepeatingTask(id, periodTicks, periodTicks));
}

/**
 * Runs a function once after `delayTicks` game ticks.
 * @param delayTicks - Ticks to wait before running the function.
 * @param run - The function to run.
 * @returns The scheduler's task id, for `cancelTask`.
 */
export function scheduleDelayed(delayTicks: number, run: (server: Server) => void): number {
    validateTicks(delayTicks, 0);
    return schedule(run, false, (id) => scheduler.scheduleDelayedTask(id, delayTicks));
}

/**
 * Stops a delayed or repeating task and releases its callback.
 * @param taskId - The id returned by either scheduling helper.
 */
export function cancelTask(taskId: number): void {
    scheduler.cancelTask(taskId);
    const handlerId = taskHandlers.get(taskId);
    if (handlerId !== undefined) tasks.take(handlerId);
    taskHandlers.delete(taskId);
}

/**
 * Registers a function to run when a command node is executed.
 * @param handler - Receives the sender and returns the command's success count.
 * @returns The id to give to `executeWithHandlerId`.
 */
export function onCommand(handler: (sender: CommandSender, args: ConsumedArgs) => number): number {
    return commandHandlers.add(handler);
}

/**
 * Runs one of this plugin's scheduled tasks.
 * @param id - The handler id the host passed back.
 * @returns False when the id belongs to the API package's own scheduler.
 */
export function runTask(id: number, server: Server): boolean {
    const handler = tasks.get(id);
    if (!handler) return false;
    if (!handler.repeating) {
        tasks.take(id);
        if (handler.taskId !== undefined) taskHandlers.delete(handler.taskId);
    }
    handler.run(server);
    return true;
}

/**
 * Runs one of this plugin's command handlers.
 * @param id - The handler id the host passed back.
 * @param sender - Who ran the command.
 * @param args - The consumed arguments from Pumpkin.
 * @returns The success count, or undefined when the id belongs to the API package.
 */
export function runCommand(id: number, sender: CommandSender, args: ConsumedArgs): number | undefined {
    return commandHandlers.get(id)?.(sender, args);
}

function validateTicks(ticks: number, minimum: number): void {
    if (!Number.isSafeInteger(ticks) || ticks < minimum) {
        throw new RangeError(`Ticks must be a safe integer greater than or equal to ${minimum}`);
    }
}

function schedule(run: (server: Server) => void, repeating: boolean, submit: (handlerId: number) => number): number {
    const handler: ScheduledHandler = { run, repeating };
    const id = tasks.add(handler);
    try {
        const taskId = submit(id);
        handler.taskId = taskId;
        taskHandlers.set(taskId, id);
        return taskId;
    } catch (error) {
        tasks.take(id);
        throw error;
    }
}
