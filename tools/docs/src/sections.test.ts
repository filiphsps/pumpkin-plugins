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
