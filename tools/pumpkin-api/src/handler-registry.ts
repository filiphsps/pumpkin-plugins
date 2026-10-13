import type { Server } from 'pumpkin:plugin/server@0.1.0';
import type { TaskHandler } from './core.ts';

interface TaskRegistration {
    handler: TaskHandler;
    repeating: boolean;
    taskId?: number;
}

const taskHandlers = new Map<number, TaskRegistration>();
const taskIds = new Map<number, number>();
let nextHandlerId = 0;

/** Allocate the next ID used to associate a Pumpkin registration with its callback. */
export function getNextHandlerId(): number {
    return nextHandlerId++;
}

/** Store a scheduled task callback and return its host-visible handler ID. */
export function registerTaskHandler(handler: TaskHandler, repeating = false): number {
    const handlerId = getNextHandlerId();
    taskHandlers.set(handlerId, { handler, repeating });
    return handlerId;
}

/** Associate a successful host scheduling result with its callback registration. */
export function trackTaskId(handlerId: number, taskId: number): void {
    const registration = taskHandlers.get(handlerId);
    if (!registration) return;
    registration.taskId = taskId;
    taskIds.set(taskId, handlerId);
}

/** Release a callback and its task ID after completion, cancellation or failed scheduling. */
export function releaseTaskHandler(handlerId: number): void {
    const registration = taskHandlers.get(handlerId);
    if (registration?.taskId !== undefined) taskIds.delete(registration.taskId);
    taskHandlers.delete(handlerId);
}

/** Find the callback belonging to an active task scheduled through the facade. */
export function getTaskHandlerId(taskId: number): number | undefined {
    return taskIds.get(taskId);
}

/** Release scheduled callbacks when Pumpkin unloads and disables the plugin's tasks. */
export function clearTaskHandlers(): void {
    taskHandlers.clear();
    taskIds.clear();
}

/** Invoke a task callback, releasing one-shot registrations before user code runs. */
export function dispatchTask(handlerId: number, server: Server): void {
    const registration = taskHandlers.get(handlerId);
    if (!registration) return;
    if (!registration.repeating) releaseTaskHandler(handlerId);
    registration.handler(server);
}
