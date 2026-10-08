import type { CommandSender } from 'pumpkin:plugin/command@0.1.0';
import type { Context } from 'pumpkin:plugin/context@0.1.0';
import { CommandFailed, defineCommands, errorLine } from '@pumpkin-plugins/docs';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const host = vi.hoisted(() => ({ onCommand: vi.fn(), color: vi.fn(), uuidToString: vi.fn(() => 'player-uuid') }));
vi.mock('./host.ts', () => ({ onCommand: host.onCommand }));
vi.mock('pumpkin:plugin/text@0.1.0', () => ({
    TextComponent: {
        text: (line: string) => ({ line, colorNamed: host.color }),
        fromLegacyString: (line: string) => ({ line, colorNamed: host.color })
    }
}));
vi.mock('pumpkin:plugin/uuid@0.1.0', () => ({ toString: host.uuidToString }));
vi.mock('pumpkin:plugin/command@0.1.0', () => {
    class Node {
        private consumed = false;

        constructor(
            public names: string[],
            public description?: string
        ) {}
        children: Node[] = [];
        // biome-ignore lint/suspicious/noThenProperty: mirrors the host command nodes.
        then = vi.fn((node: Node) => {
            this.assertAvailable();
            node.consume();
            this.children.push(node);
        });
        executeWithHandlerId = vi.fn((_id: number) => this.assertAvailable());

        private consume() {
            this.assertAvailable();
            this.consumed = true;
        }

        private assertAvailable() {
            if (this.consumed) throw new Error('Command node has already been consumed by a parent.');
        }
    }
    return {
        Command: Node,
        CommandNode: {
            literal: (name: string) => new Node([name]),
            argument: (name: string, type: unknown) => Object.assign(new Node([`<${name}>`]), { argumentType: type })
        }
    };
});

import { registerCommands } from './register-commands.ts';

const tree = defineCommands('Demo', {
    first: { description: 'First command', permission: 'Demo:command.shared' },
    second: { description: 'Second command', permission: 'Demo:command.shared' }
});
function context() {
    const registerCommand = vi.fn();
    const registerPermission = vi.fn();
    const server = {};
    return {
        ctx: { registerCommand, registerPermission, getServer: () => server } as unknown as Context,
        registerCommand,
        registerPermission,
        server
    };
}
beforeEach(() => {
    vi.resetAllMocks();
    host.onCommand.mockReturnValue(910_000);
});

describe('registerCommands', () => {
    it('registers shared permission nodes once with the default operator level', () => {
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

    it('supports per-command public defaults and sends plain and error replies', () => {
        const publicTree = defineCommands('Demo', {
            first: {
                description: 'First command',
                permission: 'Demo:command.first',
                defaultPermission: { tag: 'allow' }
            },
            second: { description: 'Second command', permission: 'Demo:command.second' }
        });
        const { ctx, registerPermission } = context();
        registerCommands(ctx, publicTree, { first: () => ['plain', errorLine('error')], second: () => [] });
        expect(registerPermission.mock.calls[0][0].default).toEqual({ tag: 'allow' });
        const sendMessage = vi.fn();
        const sender = { sendMessage } as unknown as CommandSender;
        expect(host.onCommand.mock.calls[0][0](sender)).toBe(1);
        expect(sendMessage.mock.calls.map(([component]) => component.line)).toEqual(['plain', 'error']);
        expect(host.color).toHaveBeenCalledExactlyOnceWith('red');
    });

    it('checks each nested command with its own permission while registering waterfall nodes', () => {
        const nested = defineCommands('Demo', {
            demo: {
                description: 'Manage demo',
                permission: 'Demo:command.demo',
                subcommands: {
                    public: {
                        description: 'Public listing',
                        permission: 'Demo:command.demo.public',
                        defaultPermission: { tag: 'allow' }
                    },
                    cache: {
                        description: 'Manage cache',
                        permission: 'Demo:command.demo.cache',
                        subcommands: {
                            clear: { description: 'Clear cache', permission: 'Demo:command.demo.cache.clear' }
                        }
                    }
                }
            }
        });
        const { ctx, registerCommand, registerPermission, server } = context();
        registerCommands(ctx, nested, { 'demo public': () => [], 'demo cache clear': () => [] });

        expect(registerPermission.mock.calls.map(([permission]) => permission.node)).toEqual([
            'Demo:command.demo',
            'Demo:command.demo.public',
            'Demo:command.demo.cache',
            'Demo:command.demo.cache.clear',
            'Demo:command._access'
        ]);
        expect(registerPermission.mock.calls[0][0].children).toEqual([
            { node: 'Demo:command.demo.public', value: true },
            { node: 'Demo:command.demo.cache', value: true }
        ]);
        expect(registerPermission.mock.calls[2][0].children).toEqual([
            { node: 'Demo:command.demo.cache.clear', value: true }
        ]);
        expect(registerCommand.mock.calls[0][1]).toBe('Demo:command._access');

        const root = registerCommand.mock.calls[0][0] as {
            children: unknown[];
        };
        expect(root.children).toHaveLength(2);
        const publicCommand = host.onCommand.mock.calls[0][0];
        const hasPermission = vi.fn().mockReturnValueOnce(true).mockReturnValueOnce(false);
        expect(publicCommand?.({ hasPermission })).toBe(1);
        let failure: unknown;
        try {
            publicCommand?.({ hasPermission });
        } catch (error) {
            failure = error;
        }
        expect(failure).toMatchObject({
            tag: 'command-failed',
            val: { line: 'You do not have permission to use this command.' }
        });
        expect(hasPermission).toHaveBeenNthCalledWith(1, server, 'Demo:command.demo.public');
        expect(hasPermission).toHaveBeenNthCalledWith(2, server, 'Demo:command.demo.public');
    });

    it('registers the shared root-access permission once for multiple command groups', () => {
        const grouped = defineCommands('Demo', {
            first: {
                description: 'First group',
                permission: 'Demo:command.first',
                subcommands: { status: { description: 'First status' } }
            },
            second: {
                description: 'Second group',
                permission: 'Demo:command.second',
                subcommands: { status: { description: 'Second status' } }
            }
        });
        const { ctx, registerCommand, registerPermission } = context();

        registerCommands(ctx, grouped, { 'first status': () => [], 'second status': () => [] });

        expect(
            registerPermission.mock.calls.filter(([permission]) => permission.node === 'Demo:command._access')
        ).toHaveLength(1);
        expect(registerCommand.mock.calls.map(([, permission]) => permission)).toEqual([
            'Demo:command._access',
            'Demo:command._access'
        ]);
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

    it('builds and decodes declared integer and string arguments before running the handler', () => {
        const argumentTree = defineCommands('Demo', {
            locate: {
                description: 'Find a location',
                permission: 'Demo:command.locate',
                arguments: [
                    { name: 'x', type: 'integer', min: -30_000_000, max: 30_000_000 },
                    { name: 'name', type: 'string', mode: 'quotable' }
                ]
            }
        });
        const { ctx, registerCommand } = context();
        const args = {
            getValue: vi.fn((name: string) =>
                name === 'x'
                    ? { tag: 'num', val: { tag: 'ok', val: { tag: 'int32', val: -17 } } }
                    : { tag: 'simple', val: 'spawn point' }
            ),
            [Symbol.dispose]: vi.fn()
        };
        registerCommands(ctx, argumentTree, {
            'locate <x> <name>': (_sender, received) => [`${received.x}:${received.name}`]
        });

        const commandNode = registerCommand.mock.calls[0]?.[0] as {
            children: { argumentType?: unknown; children: { argumentType?: unknown }[] }[];
        };
        expect(commandNode.children[0]?.argumentType).toEqual({ tag: 'integer', val: [-30_000_000, 30_000_000] });
        expect(commandNode.children[0]?.children[0]?.argumentType).toEqual({ tag: 'string', val: 'quotable' });

        const sendMessage = vi.fn();
        const sender = { sendMessage } as unknown as CommandSender;
        const callback = host.onCommand.mock.calls[0]?.[0] as (
            sender: CommandSender,
            consumedArgs: typeof args
        ) => number;
        expect(callback(sender, args as never)).toBe(1);
        expect(sendMessage.mock.calls.map(([component]) => component.line)).toEqual(['-17:spawn point']);
        expect(args.getValue.mock.calls).toEqual([['x'], ['name']]);
        expect(args[Symbol.dispose]).toHaveBeenCalledOnce();
    });

    it.each([
        [{ tag: 'item', val: 'minecraft:golden_apple' }, 'minecraft:golden_apple'],
        [{ tag: 'simple', val: '' }, ''],
        [{ tag: 'item-predicate', val: 'minecraft:golden_apple' }, '']
    ])('registers native item arguments and forwards the host value %j', (value, expected) => {
        const argumentTree = defineCommands('Demo', {
            icon: {
                description: 'Set an item icon',
                permission: 'Demo:command.icon',
                arguments: [{ name: 'item', type: 'item' }]
            }
        });
        const { ctx, registerCommand } = context();
        const args = {
            getValue: vi.fn(() => value),
            [Symbol.dispose]: vi.fn()
        };
        registerCommands(ctx, argumentTree, { 'icon <item>': (_sender, received) => [received.item] });

        const commandNode = registerCommand.mock.calls[0]?.[0] as {
            children: { argumentType?: unknown }[];
        };
        expect(commandNode.children[0]?.argumentType).toEqual({ tag: 'item' });

        const sendMessage = vi.fn();
        const callback = host.onCommand.mock.calls[0]?.[0] as (
            sender: CommandSender,
            consumedArgs: typeof args
        ) => number;
        expect(callback({ sendMessage } as unknown as CommandSender, args as never)).toBe(1);
        expect(sendMessage.mock.calls.map(([component]) => component.line)).toEqual([expected]);
        expect(args.getValue).toHaveBeenCalledExactlyOnceWith('item');
        expect(args[Symbol.dispose]).toHaveBeenCalledOnce();
    });

    it('decodes doubles and snapshots player selectors before disposing their WASI resources', () => {
        const argumentTree = defineCommands('Demo', {
            teleport: {
                description: 'Teleport to a waypoint',
                permission: 'Demo:command.teleport',
                arguments: [
                    { name: 'x', type: 'double', min: -30_000_000, max: 30_000_000 },
                    { name: 'targets', type: 'players' }
                ]
            }
        });
        const player = {
            getId: () => ({ high: 0, low: 1 }),
            getName: () => 'Alex',
            [Symbol.dispose]: vi.fn()
        };
        const args = {
            getValue: vi.fn((name: string) =>
                name === 'x'
                    ? { tag: 'num', val: { tag: 'ok', val: { tag: 'float64', val: 12.375 } } }
                    : { tag: 'players', val: [player] }
            ),
            [Symbol.dispose]: vi.fn()
        };
        const { ctx, registerCommand } = context();
        let received: unknown;
        registerCommands(ctx, argumentTree, {
            'teleport <x> <targets>': (_sender, value) => {
                received = value;
                return [`${value.x}:${value.targets[0]?.name}`];
            }
        });

        const commandNode = registerCommand.mock.calls[0]?.[0] as {
            children: { argumentType?: unknown; children: { argumentType?: unknown }[] }[];
        };
        expect(commandNode.children[0]?.argumentType).toEqual({
            tag: 'double',
            val: [-30_000_000, 30_000_000]
        });
        expect(commandNode.children[0]?.children[0]?.argumentType).toEqual({ tag: 'players' });

        const callback = host.onCommand.mock.calls[0]?.[0] as (
            sender: CommandSender,
            consumedArgs: typeof args
        ) => number;
        const sendMessage = vi.fn();
        expect(callback({ sendMessage } as unknown as CommandSender, args as never)).toBe(1);
        expect(received).toEqual({ x: 12.375, targets: [{ id: 'player-uuid', name: 'Alex' }] });
        expect(sendMessage.mock.calls.map(([component]) => component.line)).toEqual(['12.375:Alex']);
        expect(player[Symbol.dispose]).toHaveBeenCalledOnce();
        expect(args[Symbol.dispose]).toHaveBeenCalledOnce();
    });

    it('rejects non-finite double values and disposes consumed arguments', () => {
        const argumentTree = defineCommands('Demo', {
            locate: {
                description: 'Locate',
                permission: 'Demo:command.locate',
                arguments: [{ name: 'x', type: 'double', min: -10, max: 10 }]
            }
        });
        const args = {
            getValue: () => ({
                tag: 'num',
                val: { tag: 'ok', val: { tag: 'float64', val: Number.POSITIVE_INFINITY } }
            }),
            [Symbol.dispose]: vi.fn()
        };
        registerCommands(context().ctx, argumentTree, { 'locate <x>': () => [] });
        const callback = host.onCommand.mock.calls[0]?.[0] as (
            sender: CommandSender,
            consumedArgs: typeof args
        ) => number;

        expect(() => callback({} as CommandSender, args as never)).toThrow();
        expect(args[Symbol.dispose]).toHaveBeenCalledOnce();
    });

    it('reports malformed argument variants and releases consumed args', () => {
        const argumentTree = defineCommands('Demo', {
            count: {
                description: 'Count blocks',
                permission: 'Demo:command.count',
                arguments: [{ name: 'amount', type: 'integer' }]
            }
        });
        const { ctx } = context();
        registerCommands(ctx, argumentTree, { 'count <amount>': (_sender, args) => [String(args.amount)] });
        const args = { getValue: () => ({ tag: 'bool', val: true }), [Symbol.dispose]: vi.fn() };
        const callback = host.onCommand.mock.calls[0]?.[0] as (
            sender: CommandSender,
            consumedArgs: typeof args
        ) => number;

        let failure: unknown;
        try {
            callback({} as CommandSender, args as never);
        } catch (error) {
            failure = error;
        }
        expect(failure).toMatchObject({
            tag: 'command-failed',
            val: { line: 'Argument amount must be an integer.' }
        });
        expect(args[Symbol.dispose]).toHaveBeenCalledOnce();
    });
});
