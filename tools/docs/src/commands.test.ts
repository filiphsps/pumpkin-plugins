import { describe, expect, expectTypeOf, it } from 'vitest';
import { type CommandHandlers, type CommandPath, commandInfos, defineCommands, flattenCommands } from './commands.ts';

const commands = defineCommands('Demo', {
    demo: {
        description: 'Manage the demo',
        permission: 'Demo:command.demo',
        subcommands: {
            list: { description: 'List things' },
            pack: {
                description: 'Pack tools',
                subcommands: { add: { description: 'Add one' }, drop: { description: 'Drop one' } }
            }
        }
    },
    ping: { description: 'Answer', permission: 'Demo:command.ping' }
});

describe('flattenCommands', () => {
    it('lists the runnable commands in declaration order, with the permission of their command', () => {
        expect(flattenCommands(commands)).toEqual([
            {
                path: ['demo', 'list'],
                usage: '/demo list',
                description: 'List things',
                permission: 'Demo:command.demo'
            },
            {
                path: ['demo', 'pack', 'add'],
                usage: '/demo pack add',
                description: 'Add one',
                permission: 'Demo:command.demo'
            },
            {
                path: ['demo', 'pack', 'drop'],
                usage: '/demo pack drop',
                description: 'Drop one',
                permission: 'Demo:command.demo'
            },
            { path: ['ping'], usage: '/ping', description: 'Answer', permission: 'Demo:command.ping' }
        ]);
    });

    it('does not list a command that only groups subcommands', () => {
        expect(flattenCommands(commands).map((c) => c.usage)).not.toContain('/demo');
        expect(flattenCommands(commands).map((c) => c.usage)).not.toContain('/demo pack');
    });

    it('treats empty subcommands as a command of its own', () => {
        expect(
            flattenCommands({ x: { description: 'd', permission: 'X:x', subcommands: {} } }).map((c) => c.usage)
        ).toEqual(['/x']);
    });
});

describe('commandInfos', () => {
    it('gives the README rows', () => {
        expect(
            commandInfos({ a: { description: 'd', permission: 'X:a', subcommands: { b: { description: 'e' } } } })
        ).toEqual([{ usage: '/a b', description: 'e', permission: 'X:a' }]);
        expect(commandInfos(commands).at(-1)).toEqual({
            usage: '/ping',
            description: 'Answer',
            permission: 'Demo:command.ping'
        });
    });
});

describe('types', () => {
    it('derive the paths and require a handler for each', () => {
        expectTypeOf<CommandPath<typeof commands>>().toEqualTypeOf<
            'demo list' | 'demo pack add' | 'demo pack drop' | 'ping'
        >();

        const handler = () => ['ok'];
        const complete: CommandHandlers<typeof commands> = {
            'demo list': handler,
            'demo pack add': handler,
            'demo pack drop': handler,
            ping: handler
        };
        expect(Object.keys(complete)).toHaveLength(4);

        // @ts-expect-error a command without a handler
        const missing: CommandHandlers<typeof commands> = { 'demo list': handler, ping: handler };
        // @ts-expect-error a handler for a command that does not exist
        const extra: CommandHandlers<typeof commands> = { ...complete, 'demo nope': handler };
        expect([missing, extra]).toHaveLength(2);
    });

    it('require permission nodes to start with the plugin name', () => {
        // @ts-expect-error the node does not start with "Demo:"
        defineCommands('Demo', { demo: { description: 'd', permission: 'Other:command.demo' } });
    });
});
