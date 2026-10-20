import type { Context } from 'pumpkin:plugin/context@0.1.0';
import type { Server } from 'pumpkin:plugin/server@0.1.0';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
    handleAiGoalCanStart,
    handleAiGoalShouldContinue,
    handleAiGoalStart,
    handleAiGoalStop,
    handleAiGoalTick,
    handleCommand,
    handleCommandSuggestion,
    handleEvent,
    handleGeneratePhase,
    onUnload,
    Plugin,
    registerPlugin,
} from './core.ts';

class TestPlugin extends Plugin {
    metadata() {
        return { name: 'test', version: '1', authors: [], description: '', dependencies: [], permissions: [] };
    }
}

const server = {} as Server;

beforeEach(() => {
    onUnload({} as Context);
    registerPlugin(new TestPlugin());
});

describe('registration callback lifetime', () => {
    it.each([false, true])('clears callbacks after unload even when onUnload throws=%s', (throws) => {
        let eventId = -1;
        let commandId = -1;
        const context = {
            registerEvent(handlerId: number) {
                eventId = handlerId;
            },
            registerCommand() {},
        } as unknown as Context;
        const command = {
            executeWithHandlerId(handlerId: number) {
                commandId = handlerId;
            },
        };
        const plugin = new TestPlugin();
        const eventHandler = vi.fn((_: Server, payload: unknown) => payload);
        const commandHandler = vi.fn(() => 7);
        const suggestionHandler = vi.fn(() => []);
        const goal = {
            canStart: vi.fn(() => true),
            shouldContinue: vi.fn(() => true),
            start: vi.fn(),
            tick: vi.fn(),
            stop: vi.fn(),
        };
        const generator = vi.fn();

        plugin.registerEvent(context, 'player-join-event' as never, eventHandler as never);
        plugin.registerCommand(context, command as never, commandHandler);
        const suggestionId = plugin.registerCommandSuggestionHandler(suggestionHandler as never);
        const goalId = plugin.registerAiGoal(goal as never);
        const generatorId = plugin.registerChunkGenerator(generator as never);

        const event = { tag: 'player-join-event', val: {} } as never;
        const sender = {} as never;
        const request = {} as never;
        const entity = {} as never;
        const phase = 'surface' as never;
        const chunk = {} as never;

        handleEvent(eventId, server, event);
        expect(handleCommand(commandId, sender, server, [] as never)).toBe(7);
        handleCommandSuggestion(suggestionId, sender, server, request);
        expect(handleAiGoalCanStart(goalId, server, entity)).toBe(true);
        expect(handleAiGoalShouldContinue(goalId, server, entity)).toBe(true);
        handleAiGoalStart(goalId, server, entity);
        handleAiGoalTick(goalId, server, entity);
        handleAiGoalStop(goalId, server, entity);
        handleGeneratePhase(generatorId, phase, chunk);

        plugin.onUnload = () => {
            if (throws) throw new Error('Unload failed');
        };
        registerPlugin(plugin);
        if (throws) expect(() => onUnload({} as Context)).toThrow('Unload failed');
        else onUnload({} as Context);

        handleEvent(eventId, server, event);
        expect(() => handleCommand(commandId, sender, server, [] as never)).toThrow(`ID ${commandId}`);
        expect(() => handleCommandSuggestion(suggestionId, sender, server, request)).toThrow(`ID ${suggestionId}`);
        expect(() => handleAiGoalCanStart(goalId, server, entity)).toThrow(`ID ${goalId}`);
        expect(() => handleAiGoalShouldContinue(goalId, server, entity)).toThrow(`ID ${goalId}`);
        expect(() => handleAiGoalStart(goalId, server, entity)).toThrow(`ID ${goalId}`);
        expect(() => handleAiGoalTick(goalId, server, entity)).toThrow(`ID ${goalId}`);
        expect(() => handleAiGoalStop(goalId, server, entity)).toThrow(`ID ${goalId}`);
        expect(() => handleGeneratePhase(generatorId, phase, chunk)).toThrow(`ID ${generatorId}`);

        expect(eventHandler).toHaveBeenCalledOnce();
        expect(commandHandler).toHaveBeenCalledOnce();
        expect(suggestionHandler).toHaveBeenCalledOnce();
        expect(goal.canStart).toHaveBeenCalledOnce();
        expect(goal.canStart).toHaveBeenCalledWith(server, entity);
        expect(goal.shouldContinue).toHaveBeenCalledOnce();
        expect(goal.shouldContinue).toHaveBeenCalledWith(server, entity);
        expect(goal.start).toHaveBeenCalledOnce();
        expect(goal.start).toHaveBeenCalledWith(server, entity);
        expect(goal.tick).toHaveBeenCalledOnce();
        expect(goal.tick).toHaveBeenCalledWith(server, entity);
        expect(goal.stop).toHaveBeenCalledOnce();
        expect(goal.stop).toHaveBeenCalledWith(server, entity);
        expect(generator).toHaveBeenCalledOnce();
        expect(generator).toHaveBeenCalledWith(phase, chunk);
    });
});
