import { CommandFailed, commandInfos, defineCommands, errorLine } from '@pumpkin-plugins/docs';
import { describe, expect, it, vi } from 'vitest';
import { buildCommands } from './commands.ts';
import { FakeCommandFailure, FakeCommandHost, FakeNode } from './testing/fake-commands.ts';

const tree = defineCommands('Demo', {
    demo: {
        description: 'Manage the demo',
        permission: 'Demo:command.demo',
        subcommands: {
            list: { description: 'List things' },
            pack: { description: 'Pack tools', subcommands: { add: { description: 'Add one' } } }
        }
    },
    ping: { description: 'Answer', permission: 'Demo:command.ping' }
});

const handlers = {
    'demo list': () => ['a', 'b'],
    'demo pack add': () => ['added'],
    ping: () => ['pong']
};

describe('buildCommands', () => {
    it('models Pumpkin consuming a child node when its parent takes ownership with then', () => {
        const parent = new FakeNode('parent');
        const child = new FakeNode('child');

        parent.then(child);

        expect(parent.children).toEqual([child]);
        expect(() => child.executeWithHandlerId(1)).toThrow('already been consumed');
    });

    it('builds one root per command, with its description and permission', () => {
        const built = buildCommands(new FakeCommandHost(), tree, handlers);
        expect(built.map(({ name, description, permission }) => ({ name, description, permission }))).toEqual([
            { name: 'demo', description: 'Manage the demo', permission: 'Demo:command.demo' },
            { name: 'ping', description: 'Answer', permission: 'Demo:command.ping' }
        ]);
    });

    it('registers exactly the commands the README lists', () => {
        const host = new FakeCommandHost();
        const registered = buildCommands(host, tree, handlers).flatMap((c) => host.usages(c.node as FakeNode));
        expect(registered.sort()).toEqual(
            commandInfos(tree)
                .map((c) => c.usage)
                .sort()
        );
    });

    it('checks each declared nested permission before running its command', () => {
        const tree = defineCommands('Demo', {
            demo: {
                description: 'Manage demo',
                permission: 'Demo:command.demo',
                subcommands: {
                    list: { description: 'List', permission: 'Demo:command.demo.list' },
                    cache: {
                        description: 'Manage cache',
                        permission: 'Demo:command.demo.cache',
                        subcommands: {
                            clear: { description: 'Clear', permission: 'Demo:command.demo.cache.clear' }
                        }
                    }
                }
            }
        });
        const host = new FakeCommandHost();
        const [built] = buildCommands(host, tree, { 'demo list': () => [], 'demo cache clear': () => [] });
        const root = built?.node as FakeNode;
        const hasPermission = vi.spyOn(host, 'hasPermission');
        host.run(root, ['demo', 'list']);
        host.run(root, ['demo', 'cache', 'clear']);
        expect(hasPermission.mock.calls.map(([, permission]) => permission)).toEqual([
            'Demo:command.demo.list',
            'Demo:command.demo.cache.clear'
        ]);

        hasPermission.mockReturnValue(false);
        expect(() => host.run(root, ['demo', 'list'])).toThrow(FakeCommandFailure);
    });

    it('sends what a handler returns back to the sender, line by line', () => {
        const host = new FakeCommandHost();
        const [demo, ping] = buildCommands(host, tree, handlers).map((c) => c.node as FakeNode);
        expect(host.run(demo as FakeNode, ['demo', 'list'])).toEqual(['a', 'b']);
        expect(host.run(demo as FakeNode, ['demo', 'pack', 'add'])).toEqual(['added']);
        expect(host.run(ping as FakeNode, ['ping'])).toEqual(['pong']);
    });

    it('passes the sender to command handlers', () => {
        const host = new FakeCommandHost();
        let received: unknown;
        const [, ping] = buildCommands(host, tree, {
            ...handlers,
            ping: (sender) => {
                received = sender;
                return ['pong'];
            }
        }).map((command) => command.node as FakeNode);

        const sender = host.runAs(ping as FakeNode, ['ping']);
        expect(received).toBe(sender);
    });

    it('sends error lines in red and the rest as plain text', () => {
        const host = new FakeCommandHost();
        const [, ping] = buildCommands(host, tree, {
            ...handlers,
            ping: () => ['fine', errorLine('broken')]
        }).map((c) => c.node as FakeNode);
        const sender = host.runAs(ping as FakeNode, ['ping']);
        expect(sender.lines).toEqual(['fine', 'broken']);
        expect(sender.errors).toEqual(['broken']);
    });

    it('fails the command when a handler throws CommandFailed, and lets other errors through', () => {
        const host = new FakeCommandHost();
        const failing = {
            ...handlers,
            ping: () => {
                throw new CommandFailed('nope');
            },
            'demo list': () => {
                throw new Error('bug');
            }
        };
        const [demo, ping] = buildCommands(host, tree, failing).map((c) => c.node as FakeNode);
        expect(() => host.run(ping as FakeNode, ['ping'])).toThrow(FakeCommandFailure);
        expect(() => host.run(ping as FakeNode, ['ping'])).toThrow('nope');
        expect(() => host.run(demo as FakeNode, ['demo', 'list'])).toThrow('bug');
    });

    it('does not make a command that only groups subcommands runnable', () => {
        const host = new FakeCommandHost();
        const [demo] = buildCommands(host, tree, handlers).map((c) => c.node as FakeNode);
        expect(() => host.run(demo as FakeNode, ['demo'])).toThrow('/demo is not runnable');
        expect(() => host.run(demo as FakeNode, ['demo', 'pack'])).toThrow('/demo pack is not runnable');
    });

    it('fails when a handler is missing, as it would if the types were bypassed', () => {
        const partial = { ping: handlers.ping } as unknown as typeof handlers;
        expect(() => buildCommands(new FakeCommandHost(), tree, partial)).toThrow('no handler for /demo list');
    });
    it('validates all handlers before allocating host nodes or callbacks', () => {
        const host = new FakeCommandHost();
        const root = vi.spyOn(host, 'root');
        const onRun = vi.spyOn(host, 'onRun');
        expect(() => buildCommands(host, tree, { 'demo list': handlers['demo list'] } as typeof handlers)).toThrow(
            'no handler for /demo pack add'
        );
        expect(root).not.toHaveBeenCalled();
        expect(onRun).not.toHaveBeenCalled();
    });

    it('does not mistake an inherited property for a registered handler', () => {
        const spec = defineCommands('Demo', {
            toString: { description: 'Example', permission: 'Demo:command.example' }
        });
        expect(() => buildCommands(new FakeCommandHost(), spec, {} as never)).toThrow('no handler for /toString');
    });

    it('rejects a wrong root name in the fake host', () => {
        const host = new FakeCommandHost();
        const [, ping] = buildCommands(host, tree, handlers);
        expect(() => host.run(ping.node as FakeNode, ['wrong'])).toThrow('/wrong is not runnable');
        expect(() => host.run(ping.node as FakeNode, [])).toThrow('is not runnable');
    });

    it('builds argument nodes after literals and passes their values to typed handlers', () => {
        const argumentTree = defineCommands('Demo', {
            locate: {
                description: 'Find a location',
                permission: 'Demo:command.locate',
                subcommands: {
                    at: {
                        description: 'Look up coordinates',
                        arguments: [
                            { name: 'x', type: 'integer', min: -30_000_000, max: 30_000_000 },
                            { name: 'z', type: 'integer', min: -30_000_000, max: 30_000_000 }
                        ]
                    }
                }
            }
        });
        const host = new FakeCommandHost();
        let received: unknown;
        const [root] = buildCommands(host, argumentTree, {
            'locate at <x> <z>': (_sender, args) => {
                received = args;
                return [`${args.x},${args.z}`];
            }
        });

        expect(host.usages(root?.node as FakeNode)).toEqual(['/locate at <x> <z>']);
        expect(host.run(root?.node as FakeNode, ['locate', 'at', '<x>', '<z>'], { x: -8, z: 13 })).toEqual(['-8,13']);
        expect(received).toEqual({ x: -8, z: 13 });
        const locate = root?.node as FakeNode;
        const at = locate.children[0];
        expect(at?.children[0]?.argument).toEqual({ name: 'x', type: 'integer', min: -30_000_000, max: 30_000_000 });
        expect(at?.children[0]?.children[0]?.argument).toEqual({
            name: 'z',
            type: 'integer',
            min: -30_000_000,
            max: 30_000_000
        });
    });

    it('runs the command itself and several argument variants with shared prefixes', () => {
        const argumentTree = defineCommands('Demo', {
            locate: {
                description: 'Find cached terrain',
                permission: 'Demo:command.locate',
                argumentVariants: [
                    [{ name: 'radius', type: 'integer', min: 0, max: 16 }],
                    [
                        { name: 'x', type: 'integer' },
                        { name: 'z', type: 'integer' }
                    ],
                    [
                        { name: 'x', type: 'integer' },
                        { name: 'z', type: 'integer' },
                        { name: 'radius', type: 'integer', min: 0, max: 16 }
                    ]
                ]
            }
        });
        const host = new FakeCommandHost();
        const [root] = buildCommands(host, argumentTree, {
            locate: () => ['default'],
            'locate <radius>': (_sender, { radius }) => [`radius:${radius}`],
            'locate <x> <z>': (_sender, { x, z }) => [`position:${x},${z}`],
            'locate <x> <z> <radius>': (_sender, { x, z, radius }) => [`position:${x},${z};radius:${radius}`]
        });
        const node = root?.node as FakeNode;

        expect(host.usages(node)).toEqual([
            '/locate',
            '/locate <radius>',
            '/locate <x> <z>',
            '/locate <x> <z> <radius>'
        ]);
        expect(host.run(node, ['locate'])).toEqual(['default']);
        expect(host.run(node, ['locate', '<radius>'], { radius: 5 })).toEqual(['radius:5']);
        expect(host.run(node, ['locate', '<x>', '<z>'], { x: -8, z: 13 })).toEqual(['position:-8,13']);
        expect(host.run(node, ['locate', '<x>', '<z>', '<radius>'], { x: -8, z: 13, radius: 4 })).toEqual([
            'position:-8,13;radius:4'
        ]);

        expect(node.children).toHaveLength(2);
        expect(node.children[1]?.children).toHaveLength(1);
        expect(node.children[1]?.children[0]?.argument).toEqual({ name: 'z', type: 'integer' });
    });

    it('rejects conflicting shared argument prefixes before creating host nodes', () => {
        const invalidTree = defineCommands('Demo', {
            locate: {
                description: 'Find cached terrain',
                permission: 'Demo:command.locate',
                argumentVariants: [
                    [
                        { name: 'position', type: 'integer' },
                        { name: 'z', type: 'integer' }
                    ],
                    [
                        { name: 'position', type: 'string', mode: 'single-word' },
                        { name: 'z', type: 'integer' },
                        { name: 'radius', type: 'integer' }
                    ]
                ]
            }
        });
        const host = new FakeCommandHost();
        const root = vi.spyOn(host, 'root');

        expect(() =>
            buildCommands(host, invalidTree, {
                locate: () => [],
                'locate <position> <z>': () => [],
                'locate <position> <z> <radius>': () => []
            })
        ).toThrow('Conflicting argument definitions for <position> on /locate.');
        expect(root).not.toHaveBeenCalled();
    });

    it('rejects greedy strings before creating any command nodes unless they are final', () => {
        const invalidTree = defineCommands('Demo', {
            talk: {
                description: 'Talk',
                permission: 'Demo:command.talk',
                arguments: [
                    { name: 'message', type: 'string', mode: 'greedy' },
                    { name: 'suffix', type: 'integer' }
                ]
            }
        });
        const host = new FakeCommandHost();
        const root = vi.spyOn(host, 'root');

        expect(() => buildCommands(host, invalidTree, { 'talk <message> <suffix>': () => [] })).toThrow(
            'Greedy string argument message must be the final argument.'
        );
        expect(root).not.toHaveBeenCalled();
    });
});
