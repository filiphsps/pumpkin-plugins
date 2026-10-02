import { CommandFailed, commandInfos, defineCommands, errorLine } from '@pumpkin-plugins/docs';
import { describe, expect, it } from 'vitest';
import { buildCommands } from './commands.ts';
import { FakeCommandFailure, FakeCommandHost, type FakeNode } from './testing/fake-commands.ts';

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

    it('sends what a handler returns back to the sender, line by line', () => {
        const host = new FakeCommandHost();
        const [demo, ping] = buildCommands(host, tree, handlers).map((c) => c.node as FakeNode);
        expect(host.run(demo as FakeNode, ['demo', 'list'])).toEqual(['a', 'b']);
        expect(host.run(demo as FakeNode, ['demo', 'pack', 'add'])).toEqual(['added']);
        expect(host.run(ping as FakeNode, ['ping'])).toEqual(['pong']);
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
});
