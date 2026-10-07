import { describe, expect, it } from 'vitest';
import type { PluginInfo } from './info.ts';
import { renderBlocks, renderSections, SECTIONS } from './sections.ts';

const full: PluginInfo = {
    name: 'Demo',
    description: 'Does demo things.',
    permissions: [{ name: 'fs.read.data', reason: 'Read packs | and config' }],
    commands: [
        { usage: '/demo list', description: 'List things', permission: 'Demo:list' },
        { usage: '/demo help', description: 'Help' }
    ],
    config: {
        file: 'config.toml',
        defaultContents: '[web]\nport = 8123\n\n',
        options: [
            { key: 'web.port', type: 'integer', default: '8123', description: 'HTTP port' },
            { key: 'token', type: 'string', description: 'No default' }
        ]
    }
};

describe('renderSections', () => {
    it('renders every section from the info', () => {
        const s = renderSections(full);
        expect(Object.keys(s)).toEqual([...SECTIONS]);
        expect(s.summary).toBe('Does demo things.');
        expect(s.permissions).toContain('| `fs.read.data` | Read packs \\| and config |');
        expect(s.permissions).toContain('| `http.outbound` | Check Pumpkin Market for plugin updates. |');
        expect(s.commands).toContain('| `/demo list` | List things | `Demo:list` | operators (level 3) |');
        expect(s.commands).toContain('| `/demo help` | Help | none | operators (level 3) |');
        expect(s.config).toContain('`plugins/data/Demo/config.toml`');
        expect(s.config).toContain('| `web.port` | integer | `8123` | HTTP port |');
        expect(s.config).toContain('| `token` | string | none | No default |');
        expect(s.config).toContain('```toml\n[web]\nport = 8123\n```');
    });

    it('says what is missing instead of leaving sections empty', () => {
        const s = renderSections({ name: 'Bare', description: 'd' });
        expect(s.permissions).toContain('| `http.outbound` | Check Pumpkin Market for plugin updates. |');
        expect(s.commands).toBe('This plugin registers no commands.');
        expect(s.config).toBe('This plugin has no configuration file.');
    });

    it('renders every command permission default', () => {
        const operatorLevels = [
            ['zero', '0'],
            ['one', '1'],
            ['two', '2'],
            ['three', '3'],
            ['four', '4']
        ] as const;
        const commands: NonNullable<PluginInfo['commands']> = [
            {
                usage: '/public',
                description: 'Public',
                permission: 'Demo:command.public',
                defaultPermission: { tag: 'allow' }
            },
            ...operatorLevels.map(([val], index) => ({
                usage: `/operator${index}`,
                description: `Operator ${index}`,
                permission: `Demo:command.operator${index}` as `${string}:${string}`,
                defaultPermission: { tag: 'op' as const, val }
            })),
            {
                usage: '/denied',
                description: 'Denied',
                permission: 'Demo:command.denied' as `${string}:${string}`,
                defaultPermission: { tag: 'deny' }
            }
        ];

        const rendered = renderSections({ name: 'Demo', description: 'd', commands }).commands;

        expect(rendered).toContain('| `/public` | Public | `Demo:command.public` | everyone |');
        operatorLevels.forEach(([, level], index) => {
            expect(rendered).toContain(
                `| \`/operator${index}\` | Operator ${index} | \`Demo:command.operator${index}\` | operators (level ${level}) |`
            );
        });
        expect(rendered).toContain('| `/denied` | Denied | `Demo:command.denied` | nobody |');
    });

    it('leaves out the options table when a config has none', () => {
        const s = renderSections({ ...full, config: { file: 'c.toml', defaultContents: 'x = 1\n' } });
        expect(s.config).not.toContain('| Option |');
        expect(s.config).toContain('```toml\nx = 1\n```');
    });

    it("adds the plugin's own blocks to the built-in ones", () => {
        const blocks = renderBlocks({ ...full, blocks: { routers: '| A |' } });
        expect(Object.keys(blocks)).toEqual([...SECTIONS, 'routers']);
        expect(blocks.routers).toBe('| A |');
        expect(blocks.summary).toBe('Does demo things.');
    });

    it('does not let a plugin block take the place of a built-in one', () => {
        expect(() => renderBlocks({ ...full, blocks: { commands: 'mine' } })).toThrow('"commands" is built in');
    });
});
