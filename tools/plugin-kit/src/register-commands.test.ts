import type { CommandSender } from 'pumpkin:plugin/command@0.1.0';
import type { Context } from 'pumpkin:plugin/context@0.1.0';
import { CommandFailed, defineCommands, errorLine } from '@pumpkin-plugins/docs';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const host = vi.hoisted(() => ({ onCommand: vi.fn(), color: vi.fn() }));
vi.mock('./host.ts', () => ({ onCommand: host.onCommand }));
vi.mock('pumpkin:plugin/text@0.1.0', () => ({
    TextComponent: { text: (line: string) => ({ line, colorNamed: host.color }) }
}));
vi.mock('pumpkin:plugin/command@0.1.0', () => {
    class Node {
        constructor(
            public names: string[],
            public description?: string
        ) {}
        // biome-ignore lint/suspicious/noThenProperty: mirrors the host command nodes.
        then = vi.fn();
        executeWithHandlerId = vi.fn();
    }
    return { Command: Node, CommandNode: { literal: (name: string) => new Node([name]) } };
});

import { registerCommands } from './register-commands.ts';

const tree = defineCommands('Demo', {
    first: { description: 'First command', permission: 'Demo:command.shared' },
    second: { description: 'Second command', permission: 'Demo:command.shared' }
});
function context() {
    const registerCommand = vi.fn();
    const registerPermission = vi.fn();
    return { ctx: { registerCommand, registerPermission } as unknown as Context, registerCommand, registerPermission };
}
beforeEach(() => {
    vi.resetAllMocks();
    host.onCommand.mockReturnValue(910_000);
});

describe('registerCommands', () => {
    it('registers a shared permission once with the default operator level', () => {
        const { ctx, registerCommand, registerPermission } = context();
        registerCommands(ctx, tree, { first: () => [], second: () => [] });
        expect(registerPermission).toHaveBeenCalledExactlyOnceWith({
            node: 'Demo:command.shared',
            description: 'Use the /first command',
            default: { tag: 'op', val: 'three' },
            children: []
        });
        expect(registerCommand).toHaveBeenCalledTimes(2);
        expect(registerCommand.mock.calls.map(([node, permission]) => [node.names, permission])).toEqual([
            [['first'], 'Demo:command.shared'],
            [['second'], 'Demo:command.shared']
        ]);
    });

    it('supports permission defaults and sends plain and error replies', () => {
        const { ctx, registerPermission } = context();
        registerCommands(
            ctx,
            tree,
            { first: () => ['plain', errorLine('error')], second: () => [] },
            { defaultPermission: { tag: 'allow' } }
        );
        expect(registerPermission.mock.calls[0][0].default).toEqual({ tag: 'allow' });
        const sendMessage = vi.fn();
        const sender = { sendMessage } as unknown as CommandSender;
        expect(host.onCommand.mock.calls[0][0](sender)).toBe(1);
        expect(sendMessage.mock.calls.map(([component]) => component.line)).toEqual(['plain', 'error']);
        expect(host.color).toHaveBeenCalledExactlyOnceWith('red');
    });

    it('turns CommandFailed into the host command error result', () => {
        const { ctx } = context();
        registerCommands(ctx, tree, {
            first: () => {
                throw new CommandFailed('denied');
            },
            second: () => []
        });
        let failure: unknown;
        try {
            host.onCommand.mock.calls[0][0]({});
        } catch (error) {
            failure = error;
        }
        expect(failure).toMatchObject({ tag: 'command-failed', val: { line: 'denied' } });
        expect(host.color).toHaveBeenCalledExactlyOnceWith('red');
    });
});
