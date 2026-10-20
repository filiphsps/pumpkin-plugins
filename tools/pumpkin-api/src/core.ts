/** biome-ignore-all lint/correctness/noUnusedFunctionParameters: the default methods of the abstract class `Plugin` keep their parameter names without the `_` prefix */
import type {
    Command,
    CommandSender,
    CommandSuggestions,
    ConsumedArgs,
    CommandError as PumpkinCommandError,
    SuggestionRequest,
} from 'pumpkin:plugin/command@0.1.0';
import type { Context } from 'pumpkin:plugin/context@0.1.0';
import type { Event, EventPriority, EventType } from 'pumpkin:plugin/event@0.1.0';
import type { IpcMessage, PluginId } from 'pumpkin:plugin/ipc@0.1.0';
import type { PluginMetadata } from 'pumpkin:plugin/metadata@0.1.0';
import type { Server } from 'pumpkin:plugin/server@0.1.0';
import type { ChunkBuffer, Entity, GenerationPhase } from 'pumpkin:plugin/world@0.1.0';
import { clearTaskHandlers, dispatchTask, getNextHandlerId } from './task-registry.ts';

/**
 * Handles one Pumpkin event and may return a replacement event payload.
 *
 * Pumpkin applies the returned payload only for handlers registered as blocking. It ignores what a non-blocking
 * handler returns, so such a handler cannot modify or cancel the event. Return `undefined` to leave the payload as it
 * is.
 *
 * @template T - Payload type accepted and optionally returned by the callback.
 */
export type EventHandler<T = Event['val']> = (server: Server, event: T) => T | undefined;

/**
 * Resolves the payload associated with one Pumpkin event discriminator.
 *
 * @template T - Event discriminator whose payload should be resolved.
 */
export type EventPayload<T extends EventType> = Extract<Event, { tag: T }>['val'];

/**
 * Error value a command handler throws to fail a command.
 *
 * Pumpkin's `handle-command` export returns `result<s32, command-error>`, and the runtime turns a thrown value of this
 * type into the `err` case. Throw `{ tag: 'command-failed', val }` with a text component to show that text to the
 * sender.
 */
export type CommandError = PumpkinCommandError;

/**
 * Handles a registered command and returns its command result code.
 *
 * To fail the command, throw a {@link CommandError}. The runtime converts any other thrown value into an error itself,
 * and that conversion differs between engines.
 */
export type CommandHandler = (sender: CommandSender, server: Server, args: ConsumedArgs) => number;

/** Produces suggestions for a registered command suggestion handler. */
export type CommandSuggestionHandler = (
    sender: CommandSender,
    server: Server,
    request: SuggestionRequest,
) => CommandSuggestions;

/** Handles one scheduled task invocation. */
export type TaskHandler = (server: Server) => void;

/** Callbacks that describe a custom entity AI goal. */
export interface AiGoal {
    /** Return whether the goal can start for this entity. */
    canStart: (server: Server, entity: Entity) => boolean;
    /** Return whether the active goal should continue. */
    shouldContinue: (server: Server, entity: Entity) => boolean;
    /** Start the goal. */
    start: (server: Server, entity: Entity) => void;
    /** Stop the goal. */
    stop: (server: Server, entity: Entity) => void;
    /** Advance the goal by one server tick. */
    tick: (server: Server, entity: Entity) => void;
}

/** Generates one chunk for a requested world-generation phase. */
export type ChunkGenerator = (phase: GenerationPhase, chunk: ChunkBuffer) => void;

const eventHandlers = new Map<number, EventHandler>();
const commandHandlers = new Map<number, CommandHandler>();
const commandSuggestionHandlers = new Map<number, CommandSuggestionHandler>();
const chunkGenerators = new Map<number, ChunkGenerator>();
const aiGoals = new Map<number, AiGoal>();
let pluginInstance: Plugin | null = null;

/**
 * Provides shared behavior inherited by the public Pumpkin plugin class.
 *
 * @internal
 */
export abstract class Plugin {
    /** Return the manifest metadata supplied to the Pumpkin server. */
    abstract metadata(): PluginMetadata;

    /** Register startup handlers and perform plugin initialization. */
    onLoad(context: Context): void {}

    /** Save plugin state and release resources before unload. */
    onUnload(context: Context): void {}

    /**
     * Handle a message sent by another plugin.
     *
     * @param sender - ID of the sending plugin.
     * @param message - Message payload.
     * @returns The reply sent to the caller.
     * @throws {Error} When the plugin does not implement IPC message handling.
     */
    handleIpcMessage(sender: PluginId, message: IpcMessage): IpcMessage {
        throw new Error('This plugin does not handle IPC messages');
    }

    /**
     * Register an event callback with the Pumpkin server.
     *
     * @template T - Event discriminator that determines the callback payload.
     * @param context - Plugin context used to register the handler.
     * @param eventType - Event to receive.
     * @param handler - Callback for the event payload.
     * @param priority - Dispatch priority; defaults to `normal`. It can only order handlers within the blocking or
     * non-blocking group. Pumpkin `0.2.0+26.3-26.51` stores it but does not sort by it, so handlers in a group run in
     * registration order.
     * @param blocking - Whether Pumpkin applies the payload the handler returns; defaults to `true`. Pumpkin runs every
     * blocking handler before any non-blocking one and ignores what non-blocking handlers return, so only blocking
     * handlers can modify or cancel the event.
     * @remarks The event type determines the payload type accepted by the callback.
     */
    registerEvent<T extends EventType>(
        context: Context,
        eventType: T,
        handler: EventHandler<EventPayload<T>>,
        priority: EventPriority = 'normal',
        blocking = true,
    ): void {
        const handlerId = getNextHandlerId();
        eventHandlers.set(handlerId, (server, event) => handler(server, event as EventPayload<T>));
        try {
            context.registerEvent(handlerId, eventType, priority, blocking);
        } catch (error) {
            eventHandlers.delete(handlerId);
            throw error;
        }
    }

    /**
     * Register a command callback.
     *
     * @param context - Plugin context used to register the command.
     * @param command - Command tree configured with Pumpkin's command API.
     * @param handler - Callback invoked for the command.
     * @param permission - Permission required to run the command; defaults to no permission.
     * @remarks If assigning the handler ID or registering with the host fails, the callback is removed from the
     * dispatch registry. The command resource has no method to unset an assigned ID, so it may retain that ID after a
     * failed registration.
     */
    registerCommand(context: Context, command: Command, handler: CommandHandler, permission = ''): void {
        const handlerId = getNextHandlerId();
        commandHandlers.set(handlerId, handler);
        try {
            command.executeWithHandlerId(handlerId);
            context.registerCommand(command, permission);
        } catch (error) {
            commandHandlers.delete(handlerId);
            throw error;
        }
    }

    /** Register a command suggestion callback and return its handler ID. */
    registerCommandSuggestionHandler(handler: CommandSuggestionHandler): number {
        const handlerId = getNextHandlerId();
        commandSuggestionHandlers.set(handlerId, handler);
        return handlerId;
    }

    /**
     * Register a custom entity AI goal and return its handler ID.
     *
     * @remarks Pumpkin `0.2.0+26.3-26.51` does not start custom WASM goals because its host returns `false` from both
     * goal eligibility methods.
     */
    registerAiGoal(goal: AiGoal): number {
        const handlerId = getNextHandlerId();
        aiGoals.set(handlerId, goal);
        return handlerId;
    }

    /** Register a chunk generator and return its handler ID. */
    registerChunkGenerator(generator: ChunkGenerator): number {
        const handlerId = getNextHandlerId();
        chunkGenerators.set(handlerId, generator);
        return handlerId;
    }
}

/** Select the plugin instance whose lifecycle callbacks Pumpkin should invoke. */
export function registerPlugin(plugin: Plugin): void {
    pluginInstance = plugin;
}

/** Internal initialization hook called by the Pumpkin host. */
export function initPlugin(): void {}

/** Forward the host's load callback to the registered plugin. */
export function onLoad(context: Context): void {
    pluginInstance?.onLoad(context);
}

/** Forward the host's unload callback to the registered plugin. */
export function onUnload(context: Context): void {
    try {
        pluginInstance?.onUnload(context);
    } finally {
        clearTaskHandlers();
        eventHandlers.clear();
        commandHandlers.clear();
        commandSuggestionHandlers.clear();
        aiGoals.clear();
        chunkGenerators.clear();
    }
}

/**
 * Dispatch an event to the registered callback.
 *
 * If the callback returns a value, it replaces `event.val` before the event is returned to Pumpkin. Pumpkin applies the
 * returned event only when the handler was registered as blocking.
 */
export function handleEvent(eventId: number, server: Server, event: Event): Event {
    const handler = eventHandlers.get(eventId);
    if (handler) {
        const result = handler(server, event.val);
        if (result !== undefined) event.val = result;
    }
    return event;
}

/** Dispatch a command invocation and return the callback's result code. */
export function handleCommand(commandId: number, sender: CommandSender, server: Server, args: ConsumedArgs): number {
    return requireHandler(commandHandlers, commandId, 'command handler')(sender, server, args);
}

/** Dispatch a command suggestion request. */
export function handleCommandSuggestion(
    handlerId: number,
    sender: CommandSender,
    server: Server,
    request: SuggestionRequest,
): CommandSuggestions {
    return requireHandler(commandSuggestionHandlers, handlerId, 'command suggestion handler')(sender, server, request);
}

/** Dispatch a scheduled task invocation. Unknown task IDs are ignored. */
export function handleTask(handlerId: number, server: Server): void {
    dispatchTask(handlerId, server);
}

/**
 * Forward an IPC message to the registered plugin.
 *
 * @throws {Error} When no plugin is registered or the plugin rejects the message.
 */
export function handleIpcMessage(sender: PluginId, message: IpcMessage): IpcMessage {
    if (!pluginInstance) throw new Error('Cannot handle IPC messages before a plugin is registered');
    return pluginInstance.handleIpcMessage(sender, message);
}

/** Ask a registered AI goal whether it can start. */
export function handleAiGoalCanStart(goalId: number, server: Server, entity: Entity): boolean {
    return requireHandler(aiGoals, goalId, 'AI goal').canStart(server, entity);
}

/** Ask an active AI goal whether it should continue. */
export function handleAiGoalShouldContinue(goalId: number, server: Server, entity: Entity): boolean {
    return requireHandler(aiGoals, goalId, 'AI goal').shouldContinue(server, entity);
}

/** Notify an AI goal that it has started. */
export function handleAiGoalStart(goalId: number, server: Server, entity: Entity): void {
    requireHandler(aiGoals, goalId, 'AI goal').start(server, entity);
}

/** Advance an active AI goal by one tick. */
export function handleAiGoalTick(goalId: number, server: Server, entity: Entity): void {
    requireHandler(aiGoals, goalId, 'AI goal').tick(server, entity);
}

/** Notify an AI goal that it has stopped. */
export function handleAiGoalStop(goalId: number, server: Server, entity: Entity): void {
    requireHandler(aiGoals, goalId, 'AI goal').stop(server, entity);
}

/** Dispatch a world-generation phase to a registered chunk generator. */
export function handleGeneratePhase(generatorId: number, phase: GenerationPhase, chunk: ChunkBuffer): void {
    requireHandler(chunkGenerators, generatorId, 'generator')(phase, chunk);
}

function requireHandler<T>(handlers: Map<number, T>, id: number, label: string): T {
    const handler = handlers.get(id);
    if (handler === undefined) throw new Error(`No ${label} registered for ID ${id}`);
    return handler;
}

/** The metadata export consumed by Pumpkin during plugin loading. */
export const metadata = {
    /**
     * Return metadata from the registered plugin.
     *
     * @throws {Error} When `registerPlugin()` was not called, so Pumpkin fails the load instead of loading an unnamed
     * plugin.
     */
    getMetadata(): PluginMetadata {
        if (!pluginInstance) throw new Error('registerPlugin() was not called before Pumpkin requested metadata');
        return pluginInstance.metadata();
    },
};

/** Namespace retained for compatibility with the v0.1.1 package. */
export const common = {};
