import type { Command } from 'pumpkin:plugin/command@0.1.0';
import type { Context } from 'pumpkin:plugin/context@0.1.0';
import type { Server } from 'pumpkin:plugin/server@0.1.0';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { handleCommand, handleEvent, onUnload, Plugin } from './core.ts';

class TestPlugin extends Plugin {
    metadata() {
        return { name: 'test', version: '1', authors: [], description: '', dependencies: [], permissions: [] };
    }
}

const server = {} as Server;

beforeEach(() => {
    onUnload({} as Context);
});

describe('failed callback registration', () => {
    it('releases an event callback when the host rejects registration', () => {
        let eventId = -1;
        const context = {
            registerEvent(handlerId: number) {
                eventId = handlerId;
                throw new Error('Host rejected event');
            },
        } as unknown as Context;
        const handler = vi.fn(() => ({ handled: true }));
        const plugin = new TestPlugin();

        expect(() => plugin.registerEvent(context, 'player-join-event' as never, handler as never)).toThrow(
            'Host rejected event',
        );
        expect(eventId).not.toBe(-1);

        const event = { tag: 'player-join-event', val: {} } as never;
        expect(handleEvent(eventId, server, event)).toBe(event);
        expect(handler).not.toHaveBeenCalled();
    });

    it('releases a command callback when the host rejects registration after the ID is assigned', () => {
        let commandId = -1;
        const command = {
            executeWithHandlerId(handlerId: number) {
                commandId = handlerId;
            },
        } as unknown as Command;
        const context = {
            registerCommand() {
                throw new Error('Host rejected command');
            },
        } as unknown as Context;
        const handler = vi.fn(() => 7);

        expect(() => new TestPlugin().registerCommand(context, command, handler)).toThrow('Host rejected command');
        expect(commandId).not.toBe(-1);
        expect(() => handleCommand(commandId, {} as never, server, [] as never)).toThrow(`ID ${commandId}`);
        expect(handler).not.toHaveBeenCalled();
    });

    it('releases a command callback when assigning its handler ID throws after mutating the command', () => {
        let commandId = -1;
        const command = {
            executeWithHandlerId(handlerId: number) {
                commandId = handlerId;
                throw new Error('Command rejected handler ID');
            },
        } as unknown as Command;
        const context = { registerCommand: vi.fn() } as unknown as Context;
        const handler = vi.fn(() => 7);

        expect(() => new TestPlugin().registerCommand(context, command, handler)).toThrow(
            'Command rejected handler ID',
        );
        expect(commandId).not.toBe(-1);
        expect(() => handleCommand(commandId, {} as never, server, [] as never)).toThrow(`ID ${commandId}`);
        expect(handler).not.toHaveBeenCalled();
        expect(context.registerCommand).not.toHaveBeenCalled();
    });
});
