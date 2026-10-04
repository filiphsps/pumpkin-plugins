import type { CommandSender, ConsumedArgs } from 'pumpkin:plugin/command@0.1.0';
import * as logging from 'pumpkin:plugin/logging@0.1.0';
import * as scheduler from 'pumpkin:plugin/scheduler@0.1.0';
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
const tasks = new HandlerRegistry<() => void>(900_000);
const commandHandlers = new HandlerRegistry<(sender: CommandSender) => number>(910_000);

/**
 * Runs a function every `periodTicks` game ticks, starting after the same delay.
 * @param periodTicks - Ticks between runs.
 * @param run - The function to run.
 * @returns The scheduler's task id, for `cancelTask`.
 */
export function scheduleRepeating(periodTicks: number, run: () => void): number {
    return scheduler.scheduleRepeatingTask(tasks.add(run), periodTicks, periodTicks);
}

/**
 * Stops a repeating task.
 * @param taskId - The id `scheduleRepeating` returned.
 */
export function cancelTask(taskId: number): void {
    scheduler.cancelTask(taskId);
}

/**
 * Registers a function to run when a command node is executed.
 * @param handler - Receives the sender and returns the command's success count.
 * @returns The id to give to `executeWithHandlerId`.
 */
export function onCommand(handler: (sender: CommandSender) => number): number {
    return commandHandlers.add(handler);
}

/**
 * Runs one of this plugin's scheduled tasks.
 * @param id - The handler id the host passed back.
 * @returns False when the id belongs to the API package's own scheduler.
 */
export function runTask(id: number): boolean {
    const task = tasks.get(id);
    task?.();
    return task !== undefined;
}

/**
 * Runs one of this plugin's command handlers.
 * @param id - The handler id the host passed back.
 * @param sender - Who ran the command.
 * @param _args - The consumed arguments, unused because the commands take none.
 * @returns The success count, or undefined when the id belongs to the API package.
 */
export function runCommand(id: number, sender: CommandSender, _args: ConsumedArgs): number | undefined {
    return commandHandlers.get(id)?.(sender);
}
