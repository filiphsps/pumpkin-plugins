import { describe, expect, it, vi } from 'vitest';
import { HostPlugin } from '../src/host-plugin.ts';
import * as api from '../src/index.ts';

vi.mock('pumpkin:plugin/scheduler@0.1.0', () => ({
    scheduleDelayedTask: () => 0,
    scheduleRepeatingTask: () => 0,
    cancelTask: () => undefined,
}));

const expectedRuntimeExports = [
    'Plugin',
    'registerPlugin',
    'initPlugin',
    'onLoad',
    'onUnload',
    'handleEvent',
    'handleCommand',
    'handleCommandSuggestion',
    'handleTask',
    'handleIpcMessage',
    'handleAiGoalCanStart',
    'handleAiGoalShouldContinue',
    'handleAiGoalStart',
    'handleAiGoalTick',
    'handleAiGoalStop',
    'handleGeneratePhase',
    'metadata',
    'common',
].sort();

class TestPlugin extends api.Plugin {
    metadata() {
        return {
            name: 'test-plugin',
            version: '1.0.0',
            authors: ['test'],
            description: 'API contract fixture',
            dependencies: [],
            permissions: [],
        };
    }
}

describe('Pumpkin API v0.1.1 compatibility', () => {
    it('exports the host plugin through the public Plugin alias', () => {
        expect(api.Plugin).toBe(HostPlugin);
    });

    it('retains the old runtime export names', () => {
        expect(Object.keys(api).sort()).toEqual(expectedRuntimeExports);
    });

    it('registers a plugin and dispatches its lifecycle and event handlers', () => {
        const plugin = new TestPlugin();
        const eventId = { value: -1 };
        const context = {
            registerEvent: vi.fn((id: number) => {
                eventId.value = id;
            }),
        };
        const server = {};
        const onUnload = vi.fn();
        plugin.onUnload = onUnload;
        plugin.registerEvent(
            context as never,
            'player-join-event',
            (_server, event) =>
                ({
                    ...event,
                    observed: true,
                }) as never,
        );

        api.registerPlugin(plugin);
        api.onLoad(context as never);
        const event = { val: { player: 'alex' } };
        expect(api.handleEvent(eventId.value, server as never, event as never)).toEqual({
            val: { player: 'alex', observed: true },
        });
        api.onUnload(context as never);

        expect(context.registerEvent).toHaveBeenCalledWith(eventId.value, 'player-join-event', 'normal', true);
        expect(onUnload).toHaveBeenCalledWith(context);
    });

    it('registers command and suggestion callbacks under stable handler IDs', () => {
        const plugin = new TestPlugin();
        const commandId = { value: -1 };
        const command = {
            executeWithHandlerId: vi.fn((id: number) => {
                commandId.value = id;
            }),
        };
        const context = { registerCommand: vi.fn() };
        let receivedArgs: unknown;
        plugin.registerCommand(
            context as never,
            command as never,
            (_sender, _server, args) => {
                receivedArgs = args;
                return 2;
            },
            'test.use',
        );
        const args = { getValue: vi.fn() };
        expect(api.handleCommand(commandId.value, {} as never, {} as never, args as never)).toBe(2);
        expect(receivedArgs).toBe(args);

        const suggestionId = plugin.registerCommandSuggestionHandler((_sender, _server, request) => ({
            start: request.start,
            length: request.input.length,
            values: [{ value: request.input }],
        }));
        expect(
            api.handleCommandSuggestion(suggestionId, {} as never, {} as never, { input: 'he', start: 0 } as never),
        ).toEqual({
            start: 0,
            length: 2,
            values: [{ value: 'he' }],
        });
        expect(command.executeWithHandlerId).toHaveBeenCalledWith(commandId.value);
        expect(context.registerCommand).toHaveBeenCalledWith(command, 'test.use');
    });

    it('dispatches registered AI goal and chunk generator callbacks', () => {
        const plugin = new TestPlugin();
        const calls: string[] = [];
        const goalId = plugin.registerAiGoal({
            canStart: () => true,
            shouldContinue: () => true,
            start: () => calls.push('start'),
            tick: () => calls.push('tick'),
            stop: () => calls.push('stop'),
        });
        const generatorId = plugin.registerChunkGenerator(() => calls.push('generate'));

        expect(api.handleAiGoalCanStart(goalId, {} as never, {} as never)).toBe(true);
        expect(api.handleAiGoalShouldContinue(goalId, {} as never, {} as never)).toBe(true);
        api.handleAiGoalStart(goalId, {} as never, {} as never);
        api.handleAiGoalTick(goalId, {} as never, {} as never);
        api.handleAiGoalStop(goalId, {} as never, {} as never);
        api.handleGeneratePhase(generatorId, {} as never, {} as never);

        expect(calls).toEqual(['start', 'tick', 'stop', 'generate']);
    });

    it('returns registered plugin metadata and forwards IPC messages', () => {
        const plugin = new TestPlugin();
        plugin.handleIpcMessage = (_sender, message) => ({ ...message, response: true }) as never;
        api.registerPlugin(plugin);

        expect(api.metadata.getMetadata()).toMatchObject({ name: 'test-plugin', version: '1.0.0' });
        expect(api.handleIpcMessage('sender' as never, { body: 'ping' } as never)).toEqual({
            body: 'ping',
            response: true,
        });
    });

    it('reports an unknown command suggestion by its requested handler ID', () => {
        expect(() => api.handleCommandSuggestion(321, {} as never, {} as never, {} as never)).toThrow(
            'No command suggestion handler registered for ID 321',
        );
    });
});
