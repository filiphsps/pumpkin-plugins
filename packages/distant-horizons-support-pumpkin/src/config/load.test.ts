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
        expect(initial.memory_cache_entries).toBe(128);
        expect(initial.disk_cache_entries).toBe(4096);
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
    it('copies a legacy cache limit into both new limits and uses each default when it is absent', () => {
        const files = new MemoryFiles(),
            log = new MemoryLogger();
        files.put('config.toml', '[support]\ncache_entries = 512\n');

        const settings = readSettings(files, log);
        const config = files.text('config.toml') ?? '';

        expect(settings.memory_cache_entries).toBe(512);
        expect(settings.disk_cache_entries).toBe(512);
        expect(config).toContain('memory_cache_entries = 512');
        expect(config).toContain('disk_cache_entries = 512');
        expect(config).not.toMatch(/^cache_entries =/m);
    });
    it('accepts any negative cache limit as unlimited', () => {
        const files = new MemoryFiles(),
            log = new MemoryLogger();
        files.put('config.toml', '[support]\nmemory_cache_entries = -42\ndisk_cache_entries = -99\n');

        const settings = readSettings(files, log);

        expect(settings.memory_cache_entries).toBe(-42);
        expect(settings.disk_cache_entries).toBe(-99);
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
