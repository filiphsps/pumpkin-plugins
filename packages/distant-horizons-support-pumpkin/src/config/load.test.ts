import { MemoryFiles, MemoryLogger } from '@pumpkin-plugins/plugin-kit/testing';
import { describe, expect, it } from 'vitest';
import { readSettings } from './load.ts';

describe('DH settings', () => {
    it('creates documented defaults and keeps customized values during upgrades', () => {
        const files = new MemoryFiles(),
            log = new MemoryLogger();
        const initial = readSettings(files, log);
        expect(initial.render_distance).toBe(128);
        expect(initial.blocks_per_tick).toBe(2048);
        files.put(
            'config.toml',
            '[support]\nrender_distance = 256\nserver_key = "my-server"\n[worlds.custom]\nheight = 512\n'
        );
        const settings = readSettings(files, log);
        expect(settings.render_distance).toBe(256);
        expect(settings.server_key).toBe('my-server');
        expect(settings.worlds.custom?.height).toBe(512);
        expect(files.text('config.toml')).toContain('blocks_per_tick = 2048');
    });
    it('preserves invalid values and malformed TOML without overwriting user files', () => {
        const files = new MemoryFiles(),
            log = new MemoryLogger(),
            bad = '[support]\nrender_distance = -5\n';
        files.put('config.toml', bad);
        expect(readSettings(files, log).render_distance).toBe(128);
        expect(files.text('config.toml')).toBe(bad);
        expect(log.of('warn')).not.toHaveLength(0);
        files.put('config.toml', '[support');
        expect(() => readSettings(files, log)).toThrow();
        expect(files.text('config.toml')).toBe('[support');
    });
});
